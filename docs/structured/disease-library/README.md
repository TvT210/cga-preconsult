# 老年易发疾病信息库（线 B 资产）

> 引擎消费方：**症状—疾病匹配引擎** `backend/app/services/matching.py`。
> 数据基线：`docs/structured/disease-library/diseases.json`（schema v2）。
> 状态：**待医学专家评审**（`review_status: draft_pending_medical_review`），评审通过前不得用于正式临床提醒。

## 1. 为什么这个库要"结构化到能自动匹配"

普通疾病库给人看（ICD 字典、诊断列表），本库要**给引擎看**：每条信息都要能落到受控词表 `symptoms.json` 的 `code` 上，引擎才能自动完成
「证据 → 候选 → 打分 → 鉴别 → 分级」。因此每个字段的机器用途如下：

| 字段 | 机器用途 | 对应引擎逻辑 |
| --- | --- | --- |
| `symptoms[].weight` | 召回与打分 | core 权重 3、secondary 权重 1；得分 ÷ 该病最高可能得分 = **匹配度** |
| `differentials[]` | 同症多病鉴别 | `features` 写**本病自身的鉴别性特征**；当这些特征**一个都没命中**时扣分（负分，封顶为命中得分的 50%） |
| `protective_signs[]` | 直接排除 | 命中即扣分（默认每项 -2），比鉴别扣分更直接 |
| `red_flags[]` | 急症托底 | 命中则提醒等级**不得降级**，并至少托底到「尽快就医」（病种本身为急症则「立即就医」） |
| `risk_factors[]` | 高危因素提示 | 带 `code` 时可自动判定该老人是否具备该高危因素；不带 `code` 时仅供医护阅读 |
| `atypical_presentations[]` | 医护理解依据 | 解释「老年人为什么可以不典型」，是本项目的核心卖点之一 |
| `advice` | 对外文案 | `urgency` 决定四级提醒文案，`text` 是给老人看的通俗话 |
| `scale_links[]` | 量表关联 | 供报告「建议加做哪张量表」与分支跳转使用 |

## 2. 字段规范

```jsonc
{
  "code": "I21",                       // 疾病编码（ICD 风格），库内唯一
  "name": "急性心肌梗死",
  "aliases": ["心梗", "AMI"],           // 库内唯一，不得收录近邻病种名称
  "system": "心血管系统",
  "risk_level": "immediate",           // immediate | urgent | elective | observe
  "symptoms": [
    { "code": "chest_pain", "weight": "core", "note": "老年人可为闷痛、压榨感" }
  ],
  "atypical_presentations": ["老年人可无典型胸痛，表现为突发气促、晕厥、极度乏力"],
  "risk_factors": [
    { "factor": "2 型糖尿病", "detail": "神经病变使胸痛感受迟钝，是无痛性心梗的主要背景" }
  ],
  "red_flags": [
    { "code": "chest_pain", "term": "持续胸痛或胸部压榨感", "note": "超过 20 分钟不缓解需呼叫 120" }
  ],
  "protective_signs": [
    { "code": "fever", "term": "发热", "note": "单纯发热不支持急性心肌梗死" }
  ],
  "differentials": [
    { "vs_code": "I10", "features": ["chest_pain", "palpitations"], "points": -8, "reason": "…" }
  ],
  "scale_links": [
    { "scale": "B.1", "item": "B1-09", "note": "关注活动耐量下降" }
  ],
  "advice": { "department": "心血管内科／急诊", "urgency": "立即就医", "text": "给老人看的通俗话" },
  "source": "待医学专家评审（拟引用：老年人急性心肌梗死诊疗要点）",
  "review_note": "草稿，未经评审不得用于正式临床提醒"
}
```

### 硬性约束（校验器会卡）

1. 所有 `code`（symptoms / red_flags / protective_signs / differentials.features）**必须**来自 `symptoms.json` 的受控词表；
2. `differentials[].vs_code` 必须指向库内病种；`points` 必须为负；
3. `differentials[].features` 写**本病自身的鉴别性特征**（不是对方疾病的症状）——引擎仅在这些特征**一个都没命中**时对本病扣分，所以「全不命中 = 本病证据不足」。用 `python tools/check_differential_direction.py` 核查全库方向一致性；
4. `scale_links[].scale` 必须是真实量表；量表尚无条目时 `item` 必须为空字符串；
5. `name` + `aliases` 全库唯一；
6. 禁止出现「确诊概率 / 患病概率 / 诊断为 / 确诊为 / 一定是 / 肯定是」；
7. `source` 不得编造指南版本年份与文号（草稿阶段只写通用名称 + 「待评审」）。

## 3. 维护流程

```powershell
# 1) 校验（CI 卡口，任何一条错误都会失败）
python tools/validate_disease_library.py

# 2) 分批起草 → 合并 → 再校验
python tools/merge_disease_batches.py
```

工作流：
1. 在批次文件（`_batch_a.json` / `_batch_b.json`）中起草；
2. `merge_disease_batches.py` 合并进 `diseases.json` 并自动跑校验；
3. 医学专家评审 → 更新 `review_status` → 评审记录写 `docs/review/`。

## 4. 评审与发布

| 阶段 | `review_status` | 含义 | 系统行为 |
| --- | --- | --- | --- |
| 草稿 | `draft_pending_medical_review` | 条目待核对，来源未核实 | 可演示；**不得**产生正式临床结论；急症自动触发默认关闭 |
| 已评审 | `approved` | 经医学专家逐条核对并签字 | 可进入生产提醒 |
| 废弃 | `deprecated` | 已被新版本取代 | 仅保留历史快照，不再参与匹配 |

评审记录落 `docs/review/`，格式见 `docs/review/README.md`。

## 5. 与其他文件的边界

| 文件 | 归属 | 说明 |
| --- | --- | --- |
| `diseases.json` | **线 B** | 疾病库本体 |
| `symptoms.json` | 线 A 维护、B 提需求 | 症状归一化词表（共用资产） |
| `_disease.example.json` | 线 B | schema 范本 |
| `../assessment-scales/**` | 线 A | 21 张量表题库 |
| `backend/app/services/matching.py` | 线 B | 匹配引擎，消费本库 |
| `backend/app/db/models.py` | 分模块归属 | 疾病相关表归线 B |

> 新增病种时**不要**顺手改 `symptoms.json`（那是线 A 的文件）；把需要的词条写进批次文件的
> `missing_symptoms` 列表，由线 B 汇总后与线 A 协商一次性合并，避免两人同时改一个文件。

## 6. 当前进度

- 病种数：24 → **28**（新增 `E16.2` 严重低血糖、`E11.5` 糖尿病足、`K56` 肠梗阻、`S72.0` 股骨颈骨折）
- schema：v1（仅 symptoms / atypical / differentials）→ **v2**（新增 risk_factors / red_flags / protective_signs）
- 鉴别要点：每病 1 条 → **2~3 条**
- 校验器：`tools/validate_disease_library.py`，字段完整性 + 词表引用 + 别名唯一 + 覆盖度 + 术语红线
