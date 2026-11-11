# A-3 遗留项：staff 端派发入口 + 按 `when` 过滤题目

> 分支 `feat/A3-followups`｜日期：2026-11-11｜承接 `docs/review/2026-11-11-A3分支跳转自动派发验证记录.md`

---

## 1. 两个遗留问题是什么

A-3 合并时明确留了两条尾巴：

| 遗留项 | 原状况 | 后果 |
| --- | --- | --- |
| staff 端无派发入口 | 派发结果只在老人端结果页显示，且依赖 `user.patient_id`；医护看不到「这次评估触发了哪些后续量表」，也无法手动追加 | 医护是决定「加做哪张量表」的人，却全流程没有操作点 |
| 前端未按 `when` 过滤题目 | 计分已正确排除不适用条目，但界面仍把分流两支的题都列出来 | 没插管的老人要答「机械通气顺应性」，初筛全阴的老人还要做终筛三项 |

---

## 2. 遗留项一：派发入口与溯源

### 2.1 数据层

`AssessmentSession` 新增 `dispatch_reason`（第 3 个派发相关字段）。落库而不是临时查题库，是因为人工派发没有对应的题库分支，理由只存在于医护输入里；复核页要能直接展示「为什么多这一份」。

既有库仍由 `init_db._sync_missing_columns()` 自动补列，无需 Alembic。补出来的列可空，读取侧一律 `or ""` 兜底。

### 2.2 服务层

`branch_dispatch.py` 抽出共用建任务函数 `_new_task()`，自动派发与人工派发走同一条路径，保证：

- 建的都是 `in_progress` 空壳，不写任何作答或结论；
- 都带 `dispatched_from_id` / `dispatch_branch_code` / `dispatch_reason` 三元溯源。

新增：

| 函数 | 用途 |
| --- | --- |
| `dispatch_task()` | 人工派发。与自动派发的唯一差别是**不做环形防护**——环防护的目的是防机器无限自派生，医护要求补测/复测是合法临床决策，系统只记录派发人与理由以便追溯。去重逻辑保持一致（同量表有进行中任务则复用）。 |
| `dispatch_overview()` | 某次评估派生出的后续任务列表（含已完成），供两端展示 |
| `dispatch_source()` | 本任务由哪次评估的哪条分支触发 |

### 2.3 接口层

- `POST /assessments/dispatch`（staff+）：`{patient_id, scale_code, reason?, source_session_id?}`。
  未派发成功时**返回 200 + `message`** 而不是 4xx——前端需要按 `skip_reason` 给出「该量表条目待补录」这类具体解释，统一 400 会退化成一句无信息的报错。
- `GET /assessments/{id}` 响应新增 `dispatched_from` 与 `dispatched`，老人端与医护端共用一份，不必各算一遍。
- `POST /assessments/{id}/review` 响应新增 `dispatched`，并**在复核后重跑一次派发**。

最后一条是这次一并修掉的隐性缺口：原先复核只重算分不重派发，医护把某项改成阳性后，分支结论翻转了却没有对应待办，等于「结论变了但没人要做」。`dispatch_branches` 本身幂等（按 `branch_code` 查既有子任务），重复复核不会重复建壳。

契约见 `docs/api-contract.md` ｜ **CA-20261111-03**。

### 2.4 界面层

复核页 `/staff/review/[id]` 新增「后续评估派发」区块，四部分：

1. **来源**：本任务若由分支派发而来，显示「由『巴氏指数』评估的 B1-B1 触发（原因）」，可跳回来源评估；
2. **已派发列表**：量表名、触发分支、原因、状态（待患者填写／待复核／已复核）、打开复核；
3. **题库建议但未派发**：`scale.branches` 中没出现在 `dispatched` 里的目标（被环防护拦下、题库缺条目等），给一键「派发」，理由取题库说明；
4. **手动追加任意量表**：下拉（只列 `item_count > 0` 的）+ 理由输入 + 建待办任务。

派发后 Toast 按三种结果分别提示，并 `load()` 刷新，新任务立刻出现在列表里。

---

## 3. 遗留项二：按 `when` 过滤题目

### 3.1 为什么不能只靠后端

后端 `evaluate_scale` 已按 `when` 排除条目，所以**结论一直是对的**。问题纯在交互：题目由前端按 `scale.sections` 平铺渲染，不适用也照样出现。

### 3.2 前端求值器

新增 `frontend/src/lib/conditions.ts`，语义与后端 `scoring.evaluate_conditions` 逐条对齐：

| 后端 | 前端 |
| --- | --- |
| `{any:[…]}` / `{all:[…]}` | 同 |
| 字符串条目 = 该题阳性 | 同（`yes/y/true/1/是` 或分值 > 0） |
| `eq/ne/in` 比较选项 value，多选按逗号拆词条 | 同 |
| `lt/lte/gt/gte` 比较分值 | 同 |
| `AnswerRecord.present` | 同（`value != "" or score != null`） |

分值口径也对齐 `_apply_answer`：单选取选项 `score`、多选求和、数值题 `score = float(raw)`、实测分档题按 `min/max` 落档后取档位分值。

> 这是**只读的展示层过滤**，不参与计分。即使前端漏判，后端 `_item_applies` 仍会把关，最坏是多显示一道题，不会让结论出错。这条边界写在文件头注释里。

### 3.3 老人端交互改动

- `visibleQuestions` 替代全量题目驱动渲染、进度、题号、完成判定；
- 推进不再用 `index + 1`，改为「按作答后的答案重算可见列表 → 按题目编码定位下一题」。原因很实际：答完 B.15 的分流题后可见集合会从 3 题变 4 题，直接加下标会错位；
- 可见题数变少时（把「插管」改回「未插管」）用 effect 把停留位置收回范围内；
- 断点续填恢复位置时，在**可见列表**里找 `current_question`，否则服务端记的下一题可能是不适用的题，定位到 -1；
- 结果页逐题回溯只列本次路径上实际问过的题——不适用且未作答的题列出来，老人会误以为漏填；
- 文案从「题目总数 N 题」改为「本次需回答 N 题」，因为分流前无法确定最终题数。

### 3.4 后端配合改动

`_session_payload` 与 `submit_answer` 的 `next_question` 改为「第一个未作答**且当前适用**的题」（新增 `scoring.question_applies()`）。否则服务端会把 `B15-03` 一直当成下一题返回。

被 `when` 排除的题不答**不算缺项**——这是前端敢隐藏题目的前提，由 `missing` 只遍历过滤后的 `items` 保证，本次补了回归用例钉住。

---

## 4. 验证

| 项 | 结果 |
| --- | --- |
| 后端 `pytest` | **233 passed**（原 226 + 新增 7），零回归 |
| 前端 `tsc --noEmit` | **0 error** |
| 前端 `eslint src --max-warnings=0` | **0 error / 0 warning** |
| 接口实测 | 分流跳题、手动派发、幂等、溯源展示均符合预期（见 §4.1） |

新增用例：

| 用例 | 钉住的行为 |
| --- | --- |
| `test_staff_can_manually_dispatch_a_scale` | 手动派发建空壳、理由落库、无来源时不伪造溯源 |
| `test_manual_dispatch_reuses_ongoing_task` | 重复派发复用，不堆空壳 |
| `test_manual_dispatch_bypasses_cycle_guard` | 人工派发不被环防护拦下（与自动派发刻意不同） |
| `test_session_payload_exposes_dispatch_trace` | `dispatched_from` / `dispatched` 两字段形状 |
| `test_review_correction_triggers_dispatch` | 改分让分支翻转后补派任务 |
| `test_next_question_skips_inapplicable_gate` | B.15 未插管时 `current_question` 跳过 B15-03 |
| `test_gate_question_unanswered_is_not_counted_as_missing` | 被排除的题不答不算缺项（B.15 两支 + B.18 初筛全阴） |

### 4.1 接口实测（独立临时库）

**B.15 未插管路径**：

```
初始 next = B15-00
选 non_vent 后 next = B15-01
答完 01/02 后 next = B15-04        ← 跳过 B15-03（机械通气顺应性）
finish: total=3.0 level=疼痛行为评分 missing=[]
```

**手动派发 + 幂等**：

```json
{ "branch_code": "", "source_scale": "B.15", "target_scale": "B.4",
  "target_name": "视力简易评估表", "reason": "家属反映近期视物模糊",
  "status": "dispatched", "skip_reason": "", "session_id": 2, "session_status": "in_progress" }

重复派发 => status=reused session_id=2
```

**溯源**：

```json
parent.dispatched = [ { "session_id": 2, "target_scale": "B.4", "target_name": "视力简易评估表",
                        "branch_code": "", "reason": "家属反映近期视物模糊",
                        "status": "in_progress", "progress": 0 } ]
child.dispatched_from = { "session_id": 1, "scale_code": "B.15", "scale_name": "慢性疼痛行为评估量表",
                          "branch_code": "", "reason": "家属反映近期视物模糊" }
```

---

## 5. 边界与遗留

- **没跑 `next build`**：本机环境跑 `next build` 会稳定撞 `EPERM <distDir>/trace`，只做了 `tsc` + `eslint`；A-3 时用户本地已验过一次构建，本次改了 JSX，仍需本地终端确认一次。
- **`total_questions` 仍是全量题数**：会话进度字段未按 `when` 折算，B.15 会显示「已答 4 / 共 5」。老人端已改用可见题数，staff 端患者列表的进度条仍用旧口径。影响小，未在本轮改动，避免牵动质控指标口径。
- **人工派发不做环防护是有意为之**，与自动派发的差异写在模块 docstring 与契约里，避免后续误「统一」掉。
- **`review_status` 全部仍为 `draft_pending_medical_review`**：本轮改的是流程与交互，不是题库临床评审。
