# 模拟患者测试数据集（100 名）

> 供「老年人就医预问诊与老年综合评估系统」的**可用性与稳定性测试**使用。
> **全部为合成数据**，不含任何真实个人信息；不用于临床、不对外提供。

---

## 1. 是什么

100 名「虚拟老人」的四件套：

| 文件 | 内容 | 规模 |
| --- | --- | --- |
| `patients.json` | 基本信息 + 病史 + 疾病表征 + 真实疾病（真值） | 100 人 |
| `dialogues.jsonl` | 医患仿真对话（每行一名患者） | 3215 轮，平均 32 轮/人 |
| `scale_answers.json` | 量表作答（按真值病种推导的典型作答） | 100 组 |
| `summary.json` | 分布统计与覆盖度 | — |

配套工具：

| 工具 | 作用 |
| --- | --- |
| `tools/gen_simulated_patients.py` | 生成器（确定性，种子 `20261108`，可重复生成） |
| `tools/check_simulated_patients.py` | 自检（规模 / 锚定 / 可抽取性 / 阴性症状 / 红线 / 隐私） |

```bash
python tools/gen_simulated_patients.py        # 重新生成
python tools/check_simulated_patients.py      # 自检
```

---

## 2. 关键设计：一切锚定仓库真实资产

数据不是凭空编的，而是从仓库的受控资产推导出来：

| 数据来源 | 文件 | 用途 |
| --- | --- | --- |
| 症状词表 | `docs/structured/disease-library/symptoms.json`（113 条） | 所有症状编码、术语、同义词、鉴别问法 |
| 疾病库 | `docs/structured/disease-library/diseases.json`（28 病种） | 真值病种、核心/次要症状、风险等级 |
| 量表题库 | `docs/structured/assessment-scales/*.json`（21 张 / 113 题） | 量表作答模式 |

**因此词表一改，重新生成即可**，不会出现「词表已更新、测试数据还停在旧词」。

### 口语为什么用词表同义词

对话里患者的说法**一律取自词表同义词**（"忘事"、"记性差"、"分不清白天黑夜"、"起不来"、
"排尿费劲"…）——这些同义词本身就是地道的老人话，而且**必然能被后端抽取器命中**：

```python
# backend/app/services/dialogue.py
def extract_symptoms(text):
    for term, code in _symptom_index():      # 标准词 + 同义词
        if term and term.lower() in lowered:
            ...
```

自己另造说法会让抽取器失准，反而测不出真实问题。因此「老人原话」表只保留**故意抽不中**的
方言/口音/识别噪声句（`UNMATCHABLE`），专供「特殊交互」组使用——验证系统在被听不懂时
**追问澄清**而不是凭猜测给结论。

---

## 3. 数据结构

### 3.1 `patients.json`

```jsonc
{
  "synthetic": true,
  "count": 100,
  "seed": 20261108,
  "source": { "diseases": "...", "symptoms": "...", "scales": "..." },
  "patients": [
    {
      "synthetic": true,
      "patient_id": "SP001",
      "cohort": "clear",              // clear | vague | red_flag | comorbid | special
      "basic_info": {
        "name": "测试老人001",
        "gender": "女",
        "age": 69,
        "id_card_masked": "4401**91**1156",
        "phone": "13800000001",       // 保留测试号段
        "address": "广东省某市某区某街道26号",
        "marital_status": "离异",
        "education": "小学",
        "occupation": "退休",
        "living_arrangement": "与配偶同住",
        "language": "客家话",         // 影响语音识别难度
        "hearing": "轻度下降",
        "vision": "正常",
        "cognition": "记忆轻度减退（MCI）",
        "hand_function": "正常",
        "caregiver": "无固定照护者"
      },
      "medical_history": {
        "conditions": ["膝骨关节炎"],
        "condition_codes": ["M17"],
        "other_conditions": ["骨质疏松"],
        "surgery_history": "无",
        "medications": ["双氯芬酸钠凝胶 外用"],
        "allergy": "青霉素过敏（皮疹）",
        "family_history": "父亲有高血压",
        "lifestyle": {
          "smoking": "已戒烟 20 年", "drinking": "不饮酒",
          "exercise": "每天散步", "fall_history": "近一年无跌倒", "sleep": "入睡困难"
        }
      },
      "disease_presentation": {
        "chief_complaint": {
          "text": "…", "site": "四肢", "nature": "胀痛", "associated": "…", "onset": "受凉后"
        },
        "symptoms": [                    // 阳性症状
          {
            "symptom_code": "joint_pain", // 词表编码
            "standard_term": "关节痛",
            "severity": "moderate",       // mild | moderate | severe
            "duration": "1 周",
            "onset": "受凉后",
            "pattern": "夜间加重",
            "relieving_factor": "休息后缓解",
            "patient_expression": "这两天有点关节疼",
            "extractable": true           // false = 故意抽不中（方言/噪声）
          }
        ],
        "negative_symptoms": [            // 阴性症状（供匹配引擎给排除证据）
          { "symptom_code": "fever", "standard_term": "发热", "patient_expression": "…" }
        ]
      },
      "expected_disease": {              // ← 测试断言基准，不是系统输出
        "note": "测试断言基准，不是系统输出；系统侧禁止输出诊断结论",
        "primary": {
          "code": "M17", "name": "膝骨关节炎", "risk_level": "elective",
          "expectation": "应给出择期就诊建议，不应触发急症提醒"
        },
        "secondary": [ { "code": "…", "name": "…", "risk_level": "…", "co_present": true } ],
        "should_hit_core_symptoms": ["joint_pain", "weight_bearing_pain"],
        "distractor_disease_codes": ["M05", "S72.0", "G20", "B02"],
        "expected_top1": true,           // vague 组为 false
        "expected_top3": true,
        "review_required": false,       // red_flag/comorbid/special 为 true
        "case_intent": "主诉明确，核心症状齐备，期望匹配引擎 Top-1 命中"
      }
    }
  ]
}
```

### 3.2 `dialogues.jsonl`（每行一名患者）

```jsonc
{
  "patient_id": "SP001",
  "cohort": "clear",
  "language": "客家话",
  "hearing": "轻度下降",
  "turn_count": 32,
  "turns": [
    { "seq": 1, "role": "nurse",   "intent": "identify",
      "text": "您好，我是社区医疗的预问诊助手，先问一下您这次主要是哪里不舒服？" },
    { "seq": 2, "role": "patient", "intent": "chief_complaint",
      "text": "哎呀，这两天有点关节疼", "noise": ["filler"] },
    { "seq": 4, "role": "patient", "intent": "symptom_detail",
      "text": "休息后缓解", "symptom_code": "joint_pain",
      "severity": "moderate", "expect_extraction": true, "noise": ["self_correct"] },
    { "seq": 9, "role": "patient", "intent": "negative",
      "text": "没有发烧；没有喘不上气。",
      "negative_symptom_codes": ["fever", "dyspnea"], "noise": [] }
  ]
}
```

**采集意图（15 类）**：`identify`、`chief_complaint`、`onset`、`symptom_detail`、
`negative`、`associated`、`red_flag`、`history`、`medication`、`allergy`、
`family_history`、`lifestyle`、`fall_history`、`functional`、`preference`。

**噪声类型（5 类）**：`filler`（填充词）、`repeat`（重复）、
`self_correct`（自我更正）、`mishear`（听不清）、`offtopic`（答非所问）。

### 3.3 `scale_answers.json`

```jsonc
{ "synthetic": true, "answers": [
  { "patient_id": "SP001",
    "answers": [
      { "scale_code": "B.3", "note": "体能与平衡下降", "answer": { "score": 7 },
        "expected_risk_note": "常规" }
    ] } ] }
```

量表选取按真值病种推导（如跌倒骨折 → B.9 居家环境 + B.3 简易体能；
认知/营养类 → B.19；失禁 → B.11；慢阻肺 → B.1）。

---

## 4. 分层说明

| 分层 | 人数 | 构造 | 考察 |
| --- | --- | --- | --- |
| `clear` | 60 | 2~4 核心 + 1~3 次要症状 | 主链路顺畅、Top-1 命中 |
| `vague` | 15 | 仅 1~2 个非特异症状 | Top-3 内命中 + **触发追问** |
| `red_flag` | 10 | `immediate` 病种 + 红旗征象 | 「立即就医」提醒 + 强制人工复核 |
| `comorbid` | 10 | 2 个病种共存 | 多候选 + 冲突标记 |
| `special` | 5 | 耳背/方言/认知障碍/拒答 | 听不懂就追问，**不得臆断** |

---

## 5. 红线与隐私

- 全文**零命中**「确诊概率 / 患病概率 / 诊断为 / 建议停药」等术语（自检项 5）；
- `expected_disease` 带「测试断言基准」声明——它只是测试断言基准，
  **系统侧禁止输出诊断结论**（`AGENT.md` 领域红线 2）；
- 全部标记 `synthetic: true`；手机号固定 `1380000xxxx`（保留测试号段）；
  身份证已脱敏（`4401**xx**xxxx`）；住址只到「某市某区某街道」。

---

## 6. 怎么用

```python
import json

patients = json.load(open("docs/structured/simulated-patients/patients.json", encoding="utf-8"))["patients"]
dialogues = [json.loads(l) for l in open("docs/structured/simulated-patients/dialogues.jsonl", encoding="utf-8")]

# 断言示例：clear 组期望 Top-1 命中
for p in patients:
    if p["cohort"] == "clear":
        assert p["expected_disease"]["expected_top1"] is True

# 断言示例：red_flag 组必须触发「立即就医」
for p in patients:
    if p["expected_disease"]["primary"]["risk_level"] == "immediate":
        assert p["expected_disease"]["review_required"] is True
```

配套的测试方案见 `docs/plan/2026-11-08-模拟患者可用性与稳定性测试方案.md`。
