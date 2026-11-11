# API 契约 v1.1（双人并行开发基线）

> 依据：`docs/项目构想总需求.md` §5、§7 与根 `AGENT.md` 领域红线。
> 本版目标：让两名开发者**在不改对方代码的前提下并行推进**，因此对「信封、分页、错误、枚举、字段语义」做了明确约定。
> 状态标记：✅ 已实现并可联调 · 🟡 契约已定、实现待补 · 🔴 暂不承诺

---

## 0. 契约使用与变更规则

### 0.1 三条铁律
1. **契约先行**：任何一方新增/修改接口前，先改本文件并提「契约变更申请」（见 0.3），对方确认后才写代码。
2. **契约冻结点**：Sprint 1 第 2 天做一次**契约冻结评审**，评审结论写入 `docs/plan/契约评审记录.md`，之后进入实现期。
3. **不猜字段**：前端不得凭空假设后端字段；后端不得凭空新增返回字段。字段增加属于契约变更。

### 0.2 版本策略
- 路径前缀固定 `/api/v1`，破坏性变更不删旧字段，只**新增**并标注 `deprecated: true`。
- 破坏性变更走 `/api/v2`，并提供 3 个月并行期。
- 契约版本与后端版本解耦：本文件版本号即接口契约版本。

### 0.3 契约变更申请模板
```markdown
### 变更申请 CA-YYYYMMDD-NN
- 提出人 / 接收人：
- 影响的接口：
- 变更类型：新增字段 / 新增接口 / 字段语义变更 / 字段废弃
- 变更前 → 变更后：（贴 JSON 片段）
- 是否破坏前端现有代码：否 / 是（说明迁移点）
- 期望生效时间：
```

### 0.4 前端 Mock 约定（后端未就绪时）
- Mock 数据必须放在 `frontend/src/lib/mock/*.ts`，文件名对应接口模块，**不得**在组件里写死假数据。
- Mock 形状必须与本文件示例**逐字段一致**，字段名用下划线小写。
- Mock 开关：`NEXT_PUBLIC_USE_MOCK=1`；联调时关掉。

---

## 1. 通用约定

### 1.1 响应信封 ✅
所有 `/api/v1` 接口统一返回：

```json
{ "code": 0, "message": "ok", "data": { } }
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `code` | int | `0` = 成功；非 0 = 失败，**当前取值等于 HTTP 状态码**（v1.1 维持现状，避免打断已写好的前端；v1.2 计划拆出独立业务码 `biz_code`） |
| `message` | string | 人类可读提示，可直接用于 toast；失败时是错误原因 |
| `data` | object \| array \| null | 业务数据；失败时为 `null` |

失败响应示例：
```json
{ "code": 403, "message": "无权访问该患者的资料", "data": null }
```

### 1.2 列表返回形态（⚠️ 重点，v1.1 现状不统一）
现状有两种形态并存，**前端必须按接口表逐个对齐**：

| 形态 | 出现接口 | 说明 |
| --- | --- | --- |
| A：`{items, total, page, size}` | `GET /patients`、`GET /assessments` | 标准分页信封 |
| B：`{items, total}`（无 page/size） | `GET /patients/{id}/assessments` | 早期实现 |
| C：裸数组 `[{...}]` | 其余全部列表接口（量表、报告、提醒、随访、定期评估、匹配批次、审计日志、用户、提示词模板、同意记录、时间轴） | 无分页参数 |

> **v1.2 目标**：所有列表统一为形态 A，并支持 `page` / `size` / `sort`。
> **v1.1 期间规则**：新增接口一律用形态 A；既有接口保持原状不动，避免前端此刻大范围返工。
> 迁移时前后端需**同一 PR 内**切换，不得只改一端。

### 1.3 分页参数（形态 A 的接口）✅
| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `page` | int | 1 | 从 1 开始 |
| `size` | int | 20 | 建议上限 100 |

### 1.4 错误码与语义 ✅
| HTTP | code | 何时使用 | 前端应对 |
| --- | --- | --- | --- |
| 400 | 400 | 参数缺失/非法/选项无效 | toast 提示，不重试 |
| 401 | 401 | 未登录、token 失效、账号停用 | 清 token → 跳登录页 |
| 403 | 403 | 角色无权 / 越权访问他人数据 | 展示 `message`，不重试 |
| 404 | 404 | 资源不存在 | 展示空态 |
| 409 | 409 | 状态冲突（如报告已锁定仍要改） | 提示并刷新 |
| 500 | 500 | 服务端异常 | 友好错误态 + 可重试按钮 |

约定：**401 = 身份问题，403 = 权限问题**，二者前端处理路径不同，不可混用。

### 1.5 鉴权 ✅
- 头：`Authorization: Bearer <token>`
- token 为 JWT，HS256，默认有效期 720 分钟（`CGA_ACCESS_TOKEN_EXPIRE_MINUTES`）。
- 响应体中 `token` 字段即访问令牌，**不得**写入 URL、不得输出到日志。

### 1.6 角色与数据范围 ✅
| 角色 | key | 可访问范围 |
| --- | --- | --- |
| 老人/家属 | `elder` | **仅本人**（`users.patient_id` 绑定的那一条患者数据），越权一律 403 |
| 评估人员 | `staff` | 患者、评估、预问诊、报告生成、提醒处理 |
| 医生 | `doctor` | staff 全部 + 评估复核 + 报告审核 + 阈值修改 |
| 管理员 | `admin` | 全部 + 账号管理 + 审计日志 + 质控指标 |

### 1.7 字段与格式
| 项 | 约定 |
| --- | --- |
| 命名 | 下划线小写（`scale_code`、`match_score`） |
| 时间 | ISO 8601 字符串，含时区偏移，如 `2026-11-04T10:22:31` |
| 日期 | `YYYY-MM-DD` |
| 空值 | 字段缺失 = 键不存在；`null` = 明确为空。**不要用空字符串代替 null** |
| 布尔 | 真正的 JSON `true` / `false` |
| 数字 | 分值/比例用 number，比例取值 0~100（已按百分数存，如 `75.0` 表示 75%） |

### 1.8 术语红线（对外文案与字段一律遵守）
- 只用 **「匹配度」**（`match_score`）、**「参考概率」**（`ref_probability`）。
- 禁止「确诊概率」「患病概率」「AI 诊断」等表述。
- 所有匹配结果与就医提醒必须带 `disclaimer`：`"结果仅供参考，不构成诊断，请及时咨询医生。"`

### 1.9 幂等与重试
- 写操作（`POST`）目前**不保证幂等**；客户端重试前请先 `GET` 确认状态。
- 评估作答 `POST /assessments/{id}/answers` 对同一 `question_code` 是覆盖语义（幂等），可安全重试。
- 报告生成 `POST /reports` 每次新建一个版本，**不**幂等；重复点击会生成 v2、v3。

---

## 2. 认证 `/auth`

### POST `/auth/login` ✅
请求：
```json
{ "username": "nurse", "password": "nurse12345" }
```
响应 `data`：
```json
{
  "token": "<jwt>",
  "token_type": "bearer",
  "user": { "id": 3, "username": "nurse", "full_name": "王护士", "role": "staff", "department": "护理部", "patient_id": null }
}
```
错误：账号或密码不正确 → 401。

### GET `/auth/me` ✅
返回 `user` 对象（同上），用于前端恢复登录态。

### GET `/auth/me` 的角色码
`role` 取值仅有 `elder` / `staff` / `doctor` / `admin` 四个，前端按此做路由守卫。

---

## 3. 患者与预问诊 `/patients`

### GET `/patients?keyword=&page=&size=` ✅ → 形态 A
`keyword` 模糊匹配姓名 / 编号 / 电话。

### POST `/patients` ✅（staff+）
```json
{ "name": "张桂芳", "gender": "女", "birth_date": "1948-05-12", "phone": "13800000001",
  "id_card": "4401...", "address": "…", "emergency_contact": "…" }
```
响应 `data`：
```json
{ "id": 2, "code": "P0002", "name": "张桂芳", "gender": "女", "birth_date": "1948-05-12",
  "age": 78, "phone": "13800000001", "id_card_masked": "440***********1234",
  "address": "…", "emergency_contact": "…", "created_at": "2026-11-04T10:20:00" }
```
> `id_card` 入参即掩码存储，响应只回掩码值。

### GET `/patients/{patient_id}` ✅ · PUT `/patients/{patient_id}` ✅（staff+）
PUT 支持部分字段更新；`birth_date` 传 `YYYY-MM-DD`。

### GET / PUT `/patients/{patient_id}/preconsult` ✅
**增量保存**：请求体只带要改的字段，服务器做浅合并；顶层键为分区名。

> **归属**：预问诊的**采集与录入属线 A（患者端 / 家属端）**，写入接口供患者端调用；
> 医护端对预问诊**只读**，只保留「记录知情同意」，不提供二次编辑表单。
> 线 B（结论与运营）只做**只读消费**：把已采集内容转成匹配引擎的证据、汇入报告的
> 「疾病与用药摘要」分区，读取入口统一在 `backend/app/services/disease_library.py`。

```json
{
  "basic": { "gender": "女", "birth_date": "1948-05-12", "marital_status": "丧偶",
             "education": "小学", "living_status": "独居", "medical_insurance": "职工医保",
             "contact_name": "邱某", "contact_phone": "13900000002" },
  "chief_complaint": { "text": "反复头晕 3 天", "onset": "3天前", "site": "头部",
                       "nature": "昏沉", "severity": 3, "course": "间断", "associated": ["乏力"] },
  "history": { "conditions": ["高血压", "2 型糖尿病"],
               "medications": [{ "name": "氨氯地平", "dose": "5mg qd", "since": "2023-05" }],
               "allergies": [{ "name": "青霉素", "reaction": "皮疹" }] },
  "lifestyle": { "smoking": false, "drinking": false, "diet": "普通饮食",
                 "activity": "每日散步 20 分钟", "sleep": "入睡困难",
                 "falls": [{ "time": "2026-10-20", "place": "卫生间", "cause": "地面湿滑", "injury": "轻微擦伤" }] },
  "proxy": { "is_proxy": false, "proxy_name": "", "proxy_relation": "" }
}
```
响应 `data` 为合并后的完整内容（同结构）。

### POST `/patients/{patient_id}/consent` ✅
```json
{ "agreed": true, "scope": "评估、报告生成与就医提醒", "ai_involved": true }
```
`agreed=false` 记为撤回，`withdrawn_at` 自动写入。

### GET `/patients/{patient_id}/consents` ✅ → 裸数组
### GET `/patients/{patient_id}/timeline` ✅ → 裸数组
元素：`{ "time", "type": "assessment|report|alert|followup", "title", "detail" }`

### GET `/patients/{patient_id}/assessments` ✅ → 形态 B
```json
{ "items": [ { "id": 1, "scale_code": "B.1", "status": "reviewed", "mode": "staff", "progress": 10,
               "score": { "total": 45.0, "level": "中度依赖", "interpretation": "…", "abnormal": true,
                          "severity": "medium", "needs_manual_review": true },
               "started_at": "…", "finished_at": "…" } ], "total": 1 }
```

---

## 4. 量表中心 `/scales`

### GET `/scales` ✅ → 裸数组
```json
[ { "code": "B.1", "name": "基本日常生活活动能力评估量表", "dimension": "躯体功能",
    "method": "询问／他评", "review_status": "draft_pending_medical_review",
    "version": "0.1.0-draft", "item_count": 10, "notes": "…" } ]
```

### GET `/scales/{code}` ✅
返回完整量表定义（前端采集页的数据源）：

```json
{
  "code": "B.1", "name": "…", "dimension": "躯体功能", "method": "询问／他评",
  "standard_ref": "WS/T 888—2026 附录B B.1",
  "review_status": "draft_pending_medical_review", "version": "0.1.0-draft",
  "summary": "…", "notes": "…",
  "item_count": 10, "ready_for_scoring": true,
  "collection": { "support": ["patient","staff"], "proxy_allowed": true, "measured": false },
  "sections": [ { "code": "B1-S1", "title": "基本日常生活活动",
    "questions": [ { "code": "B1-01", "text": "进食", "plain_text": "吃饭这件事自己能完全独立完成吗？",
                    "input_type": "single", "required": true,
                    "options": [ { "value": "10", "label": "可自行进食", "score": 10 },
                                 { "value": "5",  "label": "需部分帮助",   "score": 5 },
                                 { "value": "0",  "label": "需极大帮助或完全依赖", "score": 0 } ] } ] } ],
  "scoring": { "score": { "rule_type": "sum", "config": { "items": [ { "code": "B1-01", "label": "进食", "max_score": 10 } ] } },
               "levels": { "rule_type": "level_map", "config": { "levels": [ { "min": 0, "max": 40, "level": "重度依赖", "interpretation": "…", "abnormal": true, "severity": "high" } ] } },
               "flags": [ { "rule_type": "condition", "config": { "any": [ { "question": "B1-09", "op": "lt", "value": 15 } ] }, "flag": "行走能力受限", "symptom_codes": ["difficulty_walking"], "severity": "medium" } ] },
  "branches": [ { "code": "B1-B1", "when": { "any": [ { "question": "B1-09", "op": "lt", "value": 15 } ] }, "target_scale": "B.3", "reason": "…" } ]
}
```

**题目 `input_type` 约定（前端按此渲染）**：

| input_type | 前端渲染 | 提交值 |
| --- | --- | --- |
| `single` | 单选按钮组 | 选项 `value` 字符串 |
| `multi` | 多选 | 数组或逗号串；后端按选项 `score` 求和 |
| `number` | 数字输入（实测项） | 数字，**同时**填 `measured` |
| `single` + `banded_input=true` | 数字输入 + 计时器 + 兜底选项按钮 | **只填 `measured`**，由后端按 `options[].min/max` 定档；选兜底项时填 `value` |

**实测项字段展开（服务端保证，前端可直接依赖）** ｜ CA-20261111-01

题库用 `measure: { unit, hint }` 描述实测项，`GET /scales/{code}` 与 `GET /assessments/{id}` 的题目**均已展开**，无需前端自行映射：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `unit` | string | 单位（`s` / `个` / `月`），来自 `measure.unit` |
| `unit_hint` | string | 施测提示，来自 `measure.hint` |
| `banded_input` | boolean | `true` = 实测分档题：可填数值，档位由后端裁定（`input_type` 仍为 `single`） |
| `fallback_options` | string[] | 无 `min`/`max` 的兜底选项 value（如「不能完成」），与数值输入互斥 |
| `measure` | object | 题库原始字段，保留未删 |
| `record_only` | boolean | 仅记录、不参与计分 |
| `when` | object | 条目级生效条件（如 B.15 仅在插管时启用第 3 项） |

`options[]` 增补：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `min` / `max` | number | 实测分档区间（闭区间）。两者都缺省者即兜底选项 |
| `level` / `abnormal` / `severity` | string / boolean / string | 分级型量表的选项级结论（`single_option_level` 使用） |

实测分档题示例（B.3 SPPB 步速）：

```json
{ "code": "B3-04", "text": "4 米步速", "input_type": "single", "required": true,
  "measure": { "unit": "s", "hint": "填写两次测量中的最佳值（秒）" },
  "unit": "s", "unit_hint": "填写两次测量中的最佳值（秒）",
  "banded_input": true, "fallback_options": ["unable"],
  "options": [ { "value": "lt_4_82", "label": "<4.82 s", "score": 4, "min": 0, "max": 4.82 },
               { "value": "4_82_6_20", "label": "4.82~6.20 s", "score": 3, "min": 4.821, "max": 6.2 },
               { "value": "unable", "label": "不能完成", "score": 0 } ] }
```

**提交实测值的两条路径**（后端行为）：

1. `{"question_code":"B3-04","measured":4.5}` → 落 `lt_4_82`、得 4 分；
2. `{"question_code":"B3-04","value":"unable"}` → 落兜底档、得 0 分。

数值不在任何区间内 → `422`「实测值不在任何分档区间内，请核对或交由医护人员判定」；
同时给 `value` 与 `measured` 但两者矛盾 → 采信 `value`，并在判读 `rule_refs` 记 `measured:band_check`，`needs_manual_review=true`。

**判读规则类型（`scoring.*.rule_type`）** ｜ CA-20261111-01 增补两项

| `rule_type` | 语义 |
| --- | --- |
| `sum` | 条目得分求和 |
| `count_positive` | 统计阳性条目数 |
| `max` | 取条目最大值 |
| `level_map` | 按 `config.levels[].min/max` 映射等级 |
| `condition` | 条件触发（`flags`） |
| `criteria` | **布尔组合判读**：`config.groups` 定义布尔量，`config.rules[].expr` 用 `and/or/not` 组合，按顺序取首个命中；无命中则用 `expr="default"` |
| `single_option_level` | **选项直挂结论**：等级取 `config.question` 所指题目的所选选项上的 `level/abnormal/severity`（如洼田 1~5 级） |

量表级 `review_required: true` = 标准要求「由医务人员判断」，服务端强制 `needs_manual_review=true`，前端须显示人工复核提示。

**条件算子语义（前端「规则预览」如需展示，须照此解释）**：
`eq` / `ne` / `in` 比较**选项 value 字符串**；`lt` / `lte` / `gt` / `gte` 比较**选项 score 数值**。

### POST `/scales` 🟡（admin/doctor）
请求体 = 上面的完整量表定义（`code` 必填）。返回 `{ "code", "id", "review_status" }`。

### PUT `/scales/{code}/review` ✅（admin/doctor）
```json
{ "review_status": "approved", "comment": "已按 WS/T 888—2026 附录 B 逐项核对" }
```
`review_status` 取值：`draft_pending_medical_review` | `approved` | `deprecated`

### GET `/scales/{code}/versions` ✅ → 裸数组
元素：`{ id, scale_code, version, reviewer, comment, created_at }`

---

## 5. 评估会话 `/assessments`

### POST `/assessments` ✅
```json
{ "patient_id": 2, "scale_code": "B.1", "mode": "staff",
  "proxy_name": "", "proxy_relation": "" }
```
- `mode`：`patient` | `staff`
- **断点续填**：同一患者 + 同一量表若已有 `in_progress` 会话，返回该会话而非新建（`id` 相同）。
- 若该量表条目为空（`item_count == 0`）→ 400「题库条目待补录，暂不可采集」。

响应 `data`（会话详情）：
```json
{ "id": 1, "patient_id": 2, "scale_code": "B.1", "scale_name": "…", "dimension": "躯体功能",
  "status": "in_progress", "mode": "staff",
  "proxy": { "is_proxy": false, "proxy_name": "", "proxy_relation": "" },
  "progress": 3, "total_questions": 10, "current_question": "B1-04",
  "scale_version": "0.1.0-draft", "rule_version": "0.1.0-draft",
  "started_at": "…", "finished_at": "",
  "sections": [ … ], "questions": [ … ],
  "answers": [ { "question_code": "B1-01", "value": "10", "score": 10, "skipped": false,
                 "proxy_flag": false, "answered_by": "" } ] }
```

### POST `/assessments/{session_id}/answers` ✅
```json
{ "question_code": "B1-01", "value": "5", "measured": null, "proxy_flag": false, "answered_by": "王护士" }
```
- `single`：`value` = 选项 value；`multi`：`value` = 数组或逗号串；`number`：`value` 或 `measured` 传数字。
- 同一 `question_code` 重复提交 = 覆盖。
- `proxy_flag: true` 表示代答，后端会连同 `answered_by` 落库。

响应：
```json
{ "answer": { "question_code": "B1-01", "value": "5", "score": 5, "proxy_flag": false, "answered_by": "王护士" },
  "next_question": "B1-04", "progress": 4, "total_questions": 10 }
```

### POST `/assessments/{session_id}/skip` ✅
```json
{ "question_code": "B1-07", "reason": "老人听不清" }
```
记为缺项 → 判读时 `missing_items` 非空、结论标「待人工确认」。

### POST `/assessments/{session_id}/finish` ✅
```json
{ "scores": [ { "scale_code": "B.1", "total": 45.0, "level": "中度依赖",
                "interpretation": "部分日常生活需他人协助。", "abnormal": true, "severity": "medium",
                "flags": [ { "flag": "行走能力受限", "severity": "medium",
                             "symptom_codes": ["difficulty_walking"],
                             "symptom_terms": ["行走困难"], "rule": {…} } ],
                "explanation": "10 项得分之和，满分 100 分。",
                "rule_refs": [ { "rule": "score:sum", "config": {…}, "answered_count": 10,
                                 "total_count": 10,
                                 "items": [ { "question": "B1-01", "label": "进食", "value": "5",
                                              "score": 5, "max_score": 10, "answered_by": "王护士",
                                              "proxy_flag": false } ] },
                              { "rule": "levels:level_map", "matched_level": "中度依赖", "range": [41, 60] } ],
                "missing_items": [], "needs_manual_review": true } ],
  "branches": [ { "branch_code": "B1-B1", "target_scale": "B.3", "reason": "…", "source_scale": "B.1" } ],
  "dispatched": [ { "branch_code": "B1-B1", "source_scale": "B.1", "target_scale": "B.3",
                    "target_name": "简易体能状况量表（SPPB）", "reason": "平地行走不能独立，建议实测体能。",
                    "status": "dispatched", "skip_reason": "", "session_id": 88,
                    "session_status": "in_progress" } ],
  "needs_manual_review": true, "notices": [ "题库条目待医护/专家评审，结论仅供演示，不作为正式临床结论。" ] }
```
> `rule_refs` 是「结论可回溯」的载体，前端应在结果页展示逐题作答与分值。

**分支自动派发 `dispatched`（非破坏性新增）** ｜ CA-20261111-02

`branches` 仍是「建议」列表，语义不变；`dispatched` 是这些建议的实际落库结果。筛查阳性时服务端为患者**创建待办任务**（`in_progress` 空壳），前端直接跳转 `/elder/scale/{target_scale}` 即可续填——量表页会按「患者 + 量表」自动接上这条任务，无需传 `session_id`。

| `status` | 含义 | 前端处理 |
| --- | --- | --- |
| `dispatched` | 本次新建了待办任务 | 显示「开始评估」，跳 `target_scale` |
| `reused` | 复用已有任务（此前派发过或患者自建） | 按 `session_status` 显示「继续填写」/「查看结果」 |
| `skipped` | 未派发，见 `skip_reason` | 只说明原因，不出入口 |

`skip_reason` 取值：`cycle`（目标量表已在本次评估链上，环形防护）/ `duplicate`（同一批重复推荐）/ `no_questions`（条目未补录）/ `scale_missing`（题库无此量表）。

> **约束**：派发只建任务，不代填答案、不产出结论，也不改变任何量表的分级；是否加做由患者与医护决定。题库 21 张量表共 28 条分支边且存在回指（B.1↔B.3、B.4↔B.5、B.6↔B.7、B.14↔B.15、B.8↔B.21、B.19↔B.18），服务端沿 `dispatched_from_id` 回溯评估链做环形防护，同一会话重复 `finish` 也不会重复派生（幂等）。

### POST `/assessments/{session_id}/review` ✅（staff+）
```json
{ "action": "approve", "comment": "复核一致",
  "corrections": [ { "question_code": "B1-09", "value": "10" } ] }
```
- `corrections` 提交后**自动重新计分**，返回新的 `score`。
- `action`：`approve` | `correct`

### GET `/assessments?patient_id=&scale_code=&status=&page=&size=` ✅ → 形态 A
`status`：`in_progress` | `finished` | `reviewed` | `abandoned`

### GET `/assessments/{session_id}` ✅ → 会话详情（同创建响应，另含 `score` 字段）

---

## 6. 报告 `/reports`

### POST `/reports` ✅（staff+）
```json
{ "patient_id": 2, "title": "", "template_code": "professional" }
```
- `template_code` 可选，取值见 `GET /report-templates`；缺省为 `professional`。
- 每次调用**新建一个版本**（v1、v2…），不幂等。响应 `data` 为报告对象。

### GET `/report-templates` ✅
```json
[ { "code": "professional", "name": "专业版（临床医护）", "version": "0.2.0-draft",
    "scene": "professional", "review_status": "draft_pending_medical_review", "active": true,
    "created_at": "…" },
  { "code": "plain", "name": "通俗版（老人与家属）", "version": "0.2.0-draft",
    "scene": "plain", "review_status": "draft_pending_medical_review", "active": true,
    "created_at": "…" } ]
```
报告结构由模板定义（封面/目录/分区/签署/页眉页脚/免责声明），模板基线见 `docs/structured/report-templates/`。

### GET `/reports?patient_id=` ✅ → 裸数组
元素：`{ id, patient_id, version, title, locked, created_at }`

### GET `/reports/{id}` ✅
```json
{ "id": 1, "patient_id": 2, "version": 1, "title": "张桂芳 老年综合评估报告",
  "locked": false, "disclaimer": "本报告由…生成，结果仅供参考，不构成诊断…",
  "created_at": "…",
  "sections": {
    "basic": { "patient_id": 2, "name": "张桂芳", "gender": "女", "age": 78,
               "birth_date": "1948-05-12", "phone": "…", "assessment_time": "2026-11-04 10:58",
               "assessor": "李医生", "organization": "示例社区卫生服务中心",
               "scale_count": 1, "scale_versions": ["0.1.0-draft"], "rule_versions": ["0.1.0-draft"],
               "recent_sessions": [ { "id": 1, "scale_code": "B.1", "status": "reviewed",
                                      "started_at": "…", "reviewer": "李医生" } ] },
    "scale_results": [ { "scale_code": "B.1", "scale_name": "…", "total": 45.0, "level": "中度依赖",
                         "interpretation": "…", "abnormal": true, "severity": "medium",
                         "flags": [ … ], "explanation": "…", "rule_refs": [ … ],
                         "scale_version": "0.1.0-draft", "rule_version": "0.1.0-draft",
                         "needs_manual_review": true } ],
    "dimension_summary": [ { "dimension": "躯体功能", "scale_count": 1, "abnormal_count": 1,
                             "conclusion": "共 1 项量表参与小结，1 项提示异常。",
                             "abnormal_scales": [ { "scale_code": "B.1", "level": "中度依赖", "interpretation": "…" } ] } ],
    "positive_list": [ { "scale_code": "B.1", "scale_name": "…", "level": "中度依赖", "severity": "medium",
                         "interpretation": "…", "flags": ["行走能力受限"], "need_special_assessment": true } ],
    "ai_supplement": { "dimension_conclusions": [ { "dimension": "躯体功能", "conclusion": "…" } ],
                       "trend": [], "model": "mock-deterministic-v1", "prompt_version": "0.1.0-draft",
                       "generated_at": "…", "notice": "AI 补充评估，不替代正式量表施测；与量表结果冲突时以人工复核为准。" },
    "disease_match": { "candidates": [ { "rank": 1, "disease_code": "I21", "disease_name": "急性心肌梗死",
                                         "match_score": 75.0, "ref_probability": 27.09,
                                         "hit_symptoms": [ { "code": "chest_pain", "term": "胸痛胸闷", "weight": "core" } ],
                                         "missing_symptoms": [ { "code": "…", "term": "…", "weight": "core" } ],
                                         "excluded_reasons": [ { "vs_code": "I10", "reason": "…", "points": -8 } ],
                                         "risk_level": "immediate", "advice": { … } } ],
                      "alert": { "level": "observe", "message": "…", "department": "…" },
                      "disclaimer": "结果仅供参考，不构成诊断，请及时咨询医生。", "created_at": "…" },
    "interventions": [ { "category": "运动", "items": ["B.1：行走能力受限，建议在康复治疗师指导下进行平衡与力量训练。"] } ],
    "mdt_opinions": [],
    "followup_plan": { "items": [ { "id": 1, "interval_days": 30, "due_at": "…",
                                    "focus_items": [], "status": "planned" } ], "trend": [] } } }
```

### POST `/reports/{id}/lock` ✅（staff+）
归档锁定；已锁定再调用 → 409。修改需新建版本。

### GET `/reports/{id}/export?format=docx|pdf` ✅
- `docx` → `application/vnd.openxmlformats-officedocument.wordprocessingml.document`
- `pdf` → `application/pdf`
- 文件名：`cga_report_{patient_id}_v{version}.{format}`（`Content-Disposition` 用 RFC 5987 编码）

---

## 7. 疾病库与匹配 `/diseases` `/matching`

### GET `/diseases` ✅
```json
{ "diseases": [ { "code": "I21", "name": "急性心肌梗死", "aliases": ["心梗","AMI"],
                   "system": "心血管系统", "risk_level": "immediate",
                   "review_status": "draft_pending_medical_review", "symptom_count": 7 } ],
  "thresholds": [ { "id": 1, "scope": "global", "disease_code": "", "threshold": 60.0,
                    "level": "urgent", "review_status": "draft_pending_medical_review" } ],
  "disclaimer": "结果仅供参考，不构成诊断，请及时咨询医生。" }
```

### GET `/diseases/{code}` ✅
返回该病种完整定义：`code,name,aliases,system,risk_level,review_status,symptoms[],atypical_presentations[],differentials[],scale_links[],advice{department,urgency,text},source,review_note`。
`symptoms[]` 元素：`{ code, weight: "core"|"secondary" }`；`differentials[]`：`{ vs_code, features[], points, reason }`。

### POST `/matching/run` ✅
```json
{ "patient_id": 2 }
```
响应 `data`：
```json
{ "id": 1, "patient_id": 2, "created_at": "…", "rule_version": "0.1.0-draft",
  "thresholds": { "global": 60.0, "I21": 55.0 },
  "candidates": [ { "rank": 1, "disease_code": "I21", "disease_name": "急性心肌梗死",
                    "match_score": 75.0, "ref_probability": 27.09,
                    "hit_symptoms": [ { "code": "history:I21", "term": "既往病史：2 型糖尿病", "weight": "history" },
                                      { "code": "chest_pain", "term": "胸痛胸闷", "weight": "core",
                                        "points": 4.8, "distinctive": 1.6, "shared_with": [] } ],
                    "pattern_hits": [ { "code": "pattern:I21:3", "term": "胸痛 + 气促 + 心悸同时出现…",
                                        "weight": "pattern", "points": 3.0,
                                        "symptoms": ["chest_pain", "dyspnea", "palpitations"] } ],
                    "distinctive_symptoms": [ { "code": "chest_pain", "term": "胸痛胸闷", "weight": "core",
                                                "distinctive": 1.6, "note": "仅本候选命中，是支持本病的关键线索" } ],
                    "shared_symptoms": [ { "code": "fatigue", "term": "乏力疲劳",
                                           "shared_with": ["A41", "J18"],
                                           "note": "该症状在 3 个候选中同时出现，区分度低" } ],
                    "missing_symptoms": [ { "code": "polyuria", "term": "多尿", "weight": "core" } ],
                    "excluded_reasons": [ { "vs_code": "I10", "reason": "…", "points": -8 } ],
                    "red_flags": [ { "code": "chest_pain", "term": "持续胸痛或胸部压榨感", "note": "超过 20 分钟不缓解需呼叫 120" } ],
                    "protective_signs": [ { "code": "fever", "term": "发热", "note": "单纯发热不支持急性心肌梗死" } ],
                    "risk_factor_hits": [ { "factor": "吸烟", "detail": "动脉粥样硬化基础" } ],
                    "risk_factors": [ { "factor": "2 型糖尿病", "detail": "神经病变使胸痛感受迟钝" } ],
                    "risk_level": "immediate",
                    "advice": { "department": "心血管内科 / 急诊", "urgency": "立即就医", "text": "…" },
                    "evidence_insufficient": false } ],
  "alert": { "id": 1, "level": "observe", "message": "…", "department": "…", "status": "pending",
             "red_flags": [ { "code": "chest_pain", "term": "…" } ] },
  "disclaimer": "结果仅供参考，不构成诊断，请及时咨询医生。" }
```
字段语义（前端展示必须按此）：
- `match_score` = **匹配度**（0~100，规则可解释）
- `ref_probability` = **参考概率**（0~100，候选间相对可能性，**非患病概率**）
- `evidence_insufficient` = true 表示该候选是补位展示（证据不足），前端应弱化展示
- `hit_symptoms[].weight` 可能为 `core` / `secondary` / `history`（病史命中）
- `red_flags` = 命中的**急症红旗征**；非空时该候选的提醒等级**不得降级**，并至少托底为「尽快就医」（病种本身为急症则「立即就医」）
- `protective_signs` = 命中的**保护性征象**；命中说明存在与本病不符的表现，已在 `match_score` 中扣分
- `risk_factor_hits` = 该老人已具备的高危因素（仅当疾病库条目写了 `code` 时才会出现）
- `risk_factors` = 该病的完整高危因素清单（医护阅读用，不参与打分）
- `excluded_reasons[].points` 为负值（扣分）；扣分总额以命中得分的 50% 封顶
- `hit_symptoms[].distinctive` = 该症状的**区分度系数**（0.5~2.0）：出现在越多病种的症状系数越低（共享症状说明力弱），只在一两个病种出现的系数接近 2.0（独有线索说明力强）
- `distinctive_symptoms` = **只命中本候选**的症状（支持本病的关键线索）
- `shared_symptoms` = **多个候选同时命中**的症状，附 `shared_with`（还有哪些候选命中）与区分度提示
- `pattern_hits` = 命中的**症状组合**（医生初诊看的是组合）；组合内症状全部命中时额外加分

### GET `/matching/runs?patient_id=` ✅ → 裸数组（最多 50 条）
### GET `/matching/runs/{run_id}` ✅ → 同 POST 响应结构

### GET `/matching/thresholds` ✅
```json
{ "thresholds": [ { "id": 1, "scope": "global|disease", "disease_code": "I21", "threshold": 55.0,
                    "level": "immediate", "review_status": "…", "updated_by": "系统初始化",
                    "updated_at": "…", "comment": "…" } ],
  "weights": { "core": 3.0, "secondary": 1.0, "history_bonus": 15.0, "protective_penalty": 2.0,
               "temperature": 10.0, "global_threshold": 60.0,
               "distinctive_weighting": true, "idf_floor": 0.5, "idf_cap": 2.0, "pattern_bonus": 3.0 } }
```

### POST `/matching/runs/{run_id}/ai-review` ✅（staff+）
**AI 语义复核**：在规则引擎给出的候选之上做**语义消歧**，只给**建议**，不修改任何结论。

```json
{
  "rerank": [ { "disease_code": "I21", "disease_name": "急性心肌梗死", "ai_rank": 1,
                "rationale": "命中 2 项急症红旗征", "confidence": "high" } ],
  "follow_ups": [ { "question": "老人有没有出现「心悸」这样的表现？",
                    "reason": "「心悸」是本病的关键线索，缺失会影响判断的把握", "priority": "high" } ],
  "explanations": { "I21": "（老年人可无典型胸痛…）请立即去医院急诊或拨打 120…" },
  "disagreements": [ { "disease_code": "I21", "rule_view": "规则排序第一为 高血压急症",
                       "ai_view": "语义上更倾向 急性心肌梗死",
                       "note": "规则与语义判断不一致，请医师复核后决定是否采纳" } ],
  "model": "mock-deterministic-v1", "prompt_version": "0.1.0-draft", "latency_ms": 12,
  "notice": "AI 复核意见仅供参考，不构成诊断，请以医师判断为准。"
}
```

**红线**：AI 不得输出诊断结论、不得修改 `match_score` / `ref_probability` / 阈值 / 提醒等级。
`rerank` 是**建议顺序**，与规则排序并列展示，由医护裁决；`disagreements` 显式暴露两者分歧。
`llm_provider = mock` 时走确定性模拟（离线可用），输出结构完全一致。

### GET `/matching/runs/{run_id}/ai-review` ✅
返回该批次**最近一次** AI 复核结果；未做过则 404。字段同上，额外含 `id/run_id/patient_id/created_at`。

### POST `/matching/run` 的可选参数
```json
{ "patient_id": 2, "with_ai_review": true }
```
为 `true` 时在返回体中附带 `ai_review` 字段（结构同上）。

### PUT `/matching/thresholds/{id}` ✅（doctor/admin）
```json
{ "threshold": 55.0, "level": "immediate", "review_status": "approved", "comment": "急症阈值下调" }
```
写审计日志。🟡 **v1.1 计划**：改为「提案→审批→生效」双表，接口形态将变，届时走契约变更流程。

---

## 8. 对话与定期评估 `/dialogue` `/periodic`

### POST `/dialogue/sessions` ✅ → `{ id, patient_id, title, model, prompt_version, created_at, turns: [], profile: {…} }`

### GET `/dialogue/sessions/{id}` ✅ → 同上（含 `turns[]` 与 `profile`）

### POST `/dialogue/sessions/{id}/messages` ✅
```json
{ "content": "我这几天头晕，走路发飘", "proxy": null }
```
响应：
```json
{ "reply": "您说的头晕大概持续多久了？…",
  "extracted": { "symptoms": [ { "code": "dizziness", "term": "头晕", "confidence": 0.85, "source": "dialogue" } ],
                 "proxy": null },
  "safety_note": "胸口不适可能是急症信号，请立即前往急诊或拨打 120，不要自行服药。",
  "conflict_flags": [ { "field": "symptoms", "dialogue_value": ["difficulty_walking"],
                        "scale_value": "B.1 未提示异常", "note": "对话提到…请医护复核。" } ],
  "disclaimer": "本系统不提供诊断与用药建议，结果仅供参考，不构成诊断，请及时咨询医生。",
  "model": "mock-deterministic-v1", "prompt_version": "0.1.0-draft" }
```
- `safety_note` 非空 = 命中急症安全规则，**前端必须醒目标红展示**。
- `conflict_flags` 非空 = 对话与量表不一致，**只提示不修改**。

### GET `/dialogue/sessions/{id}/profile` ✅
```json
{ "symptoms": [ { "code": "dizziness", "term": "头晕", "source": "dialogue" } ],
  "conditions": [], "medications": [], "lifestyle": {}, "chief_complaint": {}, "updated_at": "…" }
```

### POST `/dialogue/sessions/{id}/messages/stream` 🟡
契约：SSE，`data: {"reply":"…","done":false}` 逐段，`data: {"done":true,"extracted":{…},"safety_note":"…"}` 收尾。与非流式字段完全一致。

### POST `/periodic/run` ✅（staff+）
```json
{ "patient_id": 2 }
```
响应：`{ id, patient_id, dimension_conclusions[], trend[], model, prompt_version, generated_at, notice }`
`notice` 固定含「AI 补充评估，不替代正式量表施测；与量表结果冲突时以人工复核为准。」

### GET `/periodic?patient_id=` ✅ → 裸数组

---

## 9. 随访与提醒 `/followups` `/alerts`

### GET `/followups?patient_id=` ✅ → 裸数组
元素：`{ id, patient_id, interval_days, focus_items[], due_at, status, note, result, created_at }`
`status`：`planned` | `completed`

### POST `/followups` ✅（staff+）
```json
{ "patient_id": 2, "interval_days": 30, "focus_items": ["B.1 平地行走"], "note": "一个月后复评" }
```
`due_at` 由服务器按 `interval_days` 自动计算。

### POST `/followups/{id}/complete` ✅（staff+）
```json
{ "result": "ADL 评分由 45 升至 60" }
```

### GET `/alerts?patient_id=&status=` ✅ → 裸数组
元素：
```json
{ "id": 1, "patient_id": 2, "level": "urgent", "message": "…", "department": "…",
  "disclaimer": "结果仅供参考，不构成诊断，请及时咨询医生。", "status": "pending",
  "handled_by": "", "handled_at": "", "handle_comment": "", "created_at": "…" }
```
`status`：`pending` | `ack` | `escalate` | `closed`
`level`：`immediate` | `urgent` | `elective` | `observe`

### POST `/alerts/{id}/handle` ✅（staff+）
```json
{ "action": "ack", "comment": "已电话联系家属" }
```
`action`：`ack` | `escalate` | `close`

---

## 10. 医护知识库可视化 `/knowledge`（staff+）

### GET `/knowledge/graph?node_type=&keyword=` ✅
返回疾病库 + 症状词表 + 量表的关系图谱（`node_type` 取 `disease` / `symptom` / `scale`，留空为全部；`keyword` 按名称/ID 过滤）。

```json
{
  "nodes": [
    { "id": "disease:I21", "type": "disease", "label": "急性心肌梗死", "group": "心血管系统", "risk": "immediate",
      "meta": { "aliases": ["心梗"], "atypical": ["老年人可无典型胸痛…"], "advice": "…" } },
    { "id": "symptom:chest_pain", "type": "symptom", "label": "胸痛胸闷", "group": "躯体功能",
      "meta": { "synonyms": ["胸口疼", "心口疼"], "probe": "这个胸口的不舒服，是像被重东西压住一样的闷痛，还是像针扎一样的疼？" } },
    { "id": "scale:B.1", "type": "scale", "label": "基本日常生活活动能力评估量表", "group": "躯体功能",
      "meta": { "method": "询问／他评", "item_count": 10 } }
  ],
  "edges": [
    { "source": "disease:I21", "target": "symptom:chest_pain", "kind": "core", "label": "核心症状" },
    { "source": "disease:I21", "target": "scale:B.1", "kind": "focus", "label": "关注活动耐量", "item": "B1-09", "item_text": "平地行走" },
    { "source": "symptom:chest_pain", "target": "symptom:chest_discomfort", "kind": "synonym", "label": "同义：胸口压得慌" }
  ],
  "stats": { "nodes": 162, "edges": 302,
             "by_type": { "disease": 28, "symptom": 113, "scale": 21 },
             "edge_kinds": { "core": 96, "secondary": 116, "focus": 86, "synonym": 4 } },
  "notice": "图谱内容来自待医学评审的疾病库与词表草稿，仅供医护参考，不构成诊断。"
}
```

边类型：`core`（核心症状）/ `secondary`（次要症状）/ `focus`（关注量表项，带题号）/ `synonym`（症状同义）。

### GET `/knowledge/symptoms/{code}` ✅
```json
{ "code": "chest_pain", "term": "胸痛胸闷", "category": "躯体功能",
  "synonyms": ["胸口疼", "心口疼"],
  "probe": "这个胸口的不舒服，是像被重东西压住一样的闷痛，还是像针扎一样的疼？",
  "related_diseases": [ { "code": "I21", "name": "急性心肌梗死", "weight": "core", "risk_level": "immediate",
                          "system": "心血管系统", "advice": "…", "atypical": ["…"] } ],
  "related_scales": [ { "scale": "B.1", "note": "关注活动耐量", "item": "B1-09" } ],
  "disease_count": 2,
  "notice": "词条与关联病种来自待医学评审的草稿，仅供医护参考。" }
```

### GET `/knowledge/overview` ✅
`{ "diseases": 28, "symptoms": 113, "scales": 21, "scales_with_items": 21, "core_symptom_links": 96, "symptoms_with_probe": 94, "review_status": "draft_pending_medical_review" }`

---

## 11. 管理与质控 `/admin`（admin）

### GET `/admin/users` ✅ → 裸数组
### POST `/admin/users` ✅
```json
{ "username": "nurse2", "password": "…", "full_name": "赵护士", "role": "staff", "department": "护理部" }
```
### GET `/admin/audit-logs?actor=&target=&action=&limit=100` ✅ → 裸数组
元素：`{ id, actor_name, action, target_type, target_id, detail, created_at }`
`action` 取值：`create|update|view|export|lock|run|review|handle|ack|escalate|close|finish|dialogue|consent|update_threshold`
### GET `/admin/quality-metrics` ✅
质控看板数据源。分三类：**可直接计算**（现在就有数）、**由工作流喂养**（随业务推进自动积累）、**需人工标注集**（暂无数据则 `null`，不编造）。

```json
{
  "assessment_completion_rate": 0.83,
  "review_rate": 0.6,
  "abnormal_detection_rate": 0.4,
  "pending_confirmation_rate": 0.2,
  "scoring_consistency": 0.96,
  "scoring_consistency_samples": 12,
  "alert_response_rate": 0.75,
  "alert_escalation_rate": 0.1,
  "high_level_alert_ratio": 0.4,
  "false_alert_rate": 0.08,
  "false_alert_samples": 1,
  "match_accuracy": null,
  "match_recall": null,
  "top1_match_score_avg": 41.2,
  "top1_top2_gap_avg": 12.6,
  "ai_review_coverage": 0.35,
  "disease_library_coverage": 0.79,
  "disease_library_size": 28,
  "disease_hit_count": 22,
  "scale_stats": { "B.1": { "total": 12, "abnormal": 5, "pending": 2 } },
  "stats": { "patients": 4, "users": 4, "assessments": 12, "abnormal_assessments": 5,
             "reports": 3, "match_runs": 8, "alerts": 10, "pending_review": 2, "ai_reviews": 3 },
  "note": "计分一致率、误报率随「复核改分」与「标记误报」自动积累；匹配准确率与召回率需要人工标注集…",
  "generated_at": "2026-11-04T15:00:00"
}
```

指标口径：
- `scoring_consistency` = 1 −（复核中发生改分的样本 ÷ 复核样本）；数据来自 `POST /assessments/{id}/review` 时记录的前后分值。
- `false_alert_rate` = 被标记为误报的提醒数 ÷ 高等级提醒（immediate/urgent）数；数据来自 `POST /alerts/{id}/handle` 的 `action=mark_false`。
- `top1_top2_gap_avg` = Top1 与 Top2 匹配度的平均差值，**越小说明越难区分**（是难例的客观信号）。
- `match_accuracy` / `match_recall` 需要人工标注集，暂无数据故为 `null`（前端须按「暂无数据」渲染，不得当作 0）。

### POST `/alerts/{id}/handle` 的 action 取值
`ack`（已知悉）/ `escalate`（升级处理）/ `close`（关闭）/ `mark_false`（**标记为误报**，用于累计误报率）/ `revoke_false`（撤销误报标记）。

### GET `/admin/stats/overview` ✅ → 同 `stats` 对象 + `generated_at`
### GET `/admin/prompt-templates` ✅ → 裸数组
元素：`{ id, code, name, version, content, active, created_at }`

---

## 12. 枚举字典总表

| 枚举 | 取值 | 出现位置 |
| --- | --- | --- |
| `role` | `elder` / `staff` / `doctor` / `admin` | user |
| `assessment.status` | `in_progress` / `finished` / `reviewed` / `abandoned` | session |
| `review_status` | `draft_pending_medical_review` / `approved` / `deprecated` | scale / disease / threshold |
| `severity` | `none` / `low` / `medium` / `high` | score / flag |
| `alert.level` | `immediate` / `urgent` / `elective` / `observe` | alert / candidate |
| `alert.status` | `pending` / `ack` / `escalate` / `closed` | alert |
| `followup.status` | `planned` / `completed` | followup |
| `threshold.scope` | `global` / `disease` | threshold |
| `input_type` | `single` / `multi` / `number` | question |
| `dimension` | `躯体功能` / `精神心理` / `社会与环境` / `老年综合征` | scale |
| `rule_type` | `sum` / `count_positive` / `max` / `level_map` / `condition` | scoring |
| `condition.op` | `eq` / `ne` / `in` / `lt` / `lte` / `gt` / `gte` | condition |
| `symptom.weight` | `core` / `secondary`（命中证据另有 `history`） | disease / candidate |
| `match.action` | `ack` / `escalate` / `close` | alert handle |
| `review.action` | `approve` / `correct` | assessment review |

**severity 中文映射**（前端展示用）：`none`→无、`low`→轻度、`medium`→中度、`high`→重度
**alert.level 中文映射**：`immediate`→立即就医、`urgent`→尽快就医、`elective`→择期就诊、`observe`→居家观察

---

## 13. 待实现清单（🟡/🔴，前端先用 mock）

| 接口 | 状态 | 说明 |
| --- | --- | --- |
| `POST /dialogue/sessions/{id}/messages/stream` | 🟡 | SSE 流式，字段与非流式一致 |
| `GET /matching/thresholds` 的审批流形态 | 🟡 | 将改为提案/审批/生效三态 |
| `GET /patients/{id}/assessments` 分页 | 🟡 | v1.2 统一为形态 A |
| 其余列表接口分页 | 🟡 | v1.2 统一为形态 A |
| 业务错误码 `biz_code` | 🔴 | v1.2 引入，`code` 保留 HTTP 语义 |
| `POST /scales` 批量导入 | 🔴 | 暂只支持单表创建 |
| 题目口语化改写接口 | 🔴 | 待数据侧定稿 |
| 实测项计时上报接口 | 🔴 | 与 B.3 条目补录同步 |

---

## 14. 联调约定

1. **端口**：后端 `127.0.0.1:8000`，前端 `127.0.0.1:3000`。CORS 白名单只放行 3000 端口，**前端换端口会被浏览器拦**，这是已知坑。
2. **启动顺序**：后端起好（`/health` 返回 ok）→ 前端起。
3. **演示账号**：`admin/admin12345`、`doctor/doctor12345`、`nurse/nurse12345`、`elder/elder12345`（elder 绑定演示患者）。
4. **数据隔离**：开发期共用一个 SQLite（`backend/data/cga.db`）。两人同时造数据会互相干扰 → **各自用独立库**：后端启动前设 `CGA_DATABASE_URL=sqlite:///./data/cga_<你的名字>.db`。
5. **契约校验**：CI 中跑「契约声明 vs OpenAPI」比对，缺接口即失败，防止文档与实现漂移。
