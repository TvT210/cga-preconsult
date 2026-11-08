"""生成 100 名模拟患者测试数据集（供「可用性与稳定性测试」使用）。

设计原则
========
1. **锚定真实资产**：所有症状编码取自 `docs/structured/disease-library/symptoms.json`
   （113 条），真值病种取自 `docs/structured/disease-library/diseases.json`（28 病种），
   量表作答模式依据 `docs/structured/assessment-scales/*.json`（21 张 / 113 题）。
   这样词表一改，测试集跟着变，不会出现「词表已改、测试数据还停在旧词」。

2. **可对话抽取**：对话里的症状说法一律由词表标准词 `term` 或**老人原话**生成——
   后端 `services/dialogue.py` 的 `extract_symptoms()` 按「标准词 + 同义词」做文本匹配，
   因此这份对话可以直接喂给抽取器验证召回率。

3. **阴性症状也进对话**：患者会主动说「我没发烧」「腿不肿」，
   匹配引擎需要这些信息才能给出「缺失关键症状」与被排除理由。

4. **确定性**：固定随机种子（`--seed`），同一命令重复执行结果完全一致，便于回归对比。

5. **红线**：
   - 不出现「确诊概率」「患病概率」等术语；真值字段用 `expected_disease`，
     明确它只是**测试断言基准**，不是系统输出；
   - 全部数据标注 `synthetic: true`，身份/电话使用保留测试号段，不含真实个人信息。

用法
====
    python tools/gen_simulated_patients.py                 # 默认 100 人
    python tools/gen_simulated_patients.py --count 20 --seed 7
"""

from __future__ import annotations

import argparse
import json
import pathlib
import random
from typing import Any

ROOT = pathlib.Path(__file__).resolve().parent.parent
DISEASES_PATH = ROOT / "docs/structured/disease-library/diseases.json"
SYMPTOMS_PATH = ROOT / "docs/structured/disease-library/symptoms.json"
OUT_DIR = ROOT / "docs/structured/simulated-patients"

DEFAULT_SEED = 20261108
DEFAULT_COUNT = 100

# ---------------------------------------------------------------------------
# 故意**抽不中**的说法（模拟方言 / 口音 / ASR 错字）
# ---------------------------------------------------------------------------
# 这些说法不在词表里，后端 `extract_symptoms()` 匹配不到。
# 它们只出现在「特殊交互」组，用来验证系统在被听不懂时
# **追问澄清**而不是凭猜测给结论（符合「AI 不诊断、不臆断」红线）。

UNMATCHABLE = {
    "orientation_deficit": "脑壳子糊了，不晓得好些",
    "hearing_impairment": "耳朵不行了，声音进不来",
    "dysarthria": "舌头打结，说话漏风",
    "dysuria": "尿尿那会儿火辣辣的疼",
    "constipation": "拉不出来，蹲半天",
    "dyspnea": "气不够用，胸口像压了块石头",
    "fatigue": "身上一点劲儿都没有",
    "insomnia": "整夜翻来覆去，天亮了才打个盹",
    "memory_decline": "脑子进水了，啥都记不住",
    "gait_slow": "腿脚不利索，走一步歇三步",
    "joint_pain": "骨头缝里钻心地疼",
    "chest_pain": "心口窝这儿压得慌",
    "weight_loss": "人瘦得脱了形",
    "poor_appetite": "饭点到了也懒得动筷子",
    "edema": "两条腿跟发面蒸的似的，鼓一圈",
    "tremor": "手直哆嗦，拿不住东西",
    "nocturia": "夜里一趟接一趟往厕所跑",
    "skin_breakdown": "身上烂了一块，流水",
    "cough": "嗓子眼里老是想咳，咳也咳不出东西",
    "delirium_fluctuation": "一会儿明白一会儿不明白",
    "nausea_vomiting": "翻江倒海地吐",
}

# 时间状语（老年人主诉的典型开头）
ONSET_PREFIX = [
    "这两天", "最近几天", "今儿早上", "前两天开始", "这半个月",
    "上个月开始", "最近一个礼拜", "昨晚开始", "过完节以后", "入秋以后",
    "这一个多月", "打那回摔倒以后",
]

# 程度副词（放在症状前，读起来自然）
DEGREE_ADVERB = {
    "mild": ["有点", "稍微", "不算厉害", "不算太明显"],
    "moderate": ["有点厉害", "挺明显", "说不上特别厉害", "比平时明显"],
    "severe": ["厉害得很", "特别严重", "受不了啦", "整个都扛不住"],
}

ELDER_SUFFIX = [
    "，人老了就这样", "，也不碍事", "，就是不得劲", "，晚上更厉害",
    "，歇一歇就好点", "，我也没当回事", "，反正就一直这样",
]

# 症状「起病方式」与「发作规律」是两个不同维度，分开取值
ONSET_PATTERN = ["突然就犯了", "慢慢起来的", "受凉之后", "累完之后", "说不太清什么时候"]
SYMPTOM_PATTERN = ["夜间加重", "活动后加重", "休息后缓解", "一直都有", "一阵一阵的"]

LANGUAGES = ["普通话", "粤语", "客家话", "闽南话", "四川话"]
HEARING = ["正常", "轻度下降", "中度下降", "老年性耳聋（需大声说）"]
VISION = ["正常", "老花", "白内障术后", "视力明显下降"]
COGNITION = ["正常", "记忆轻度减退（MCI）", "轻度认知障碍", "需家属代答"]
HAND_FUNCTION = ["正常", "骨关节炎（握力下降）", "手抖（精细动作困难）"]
LIVING = ["与配偶同住", "与子女同住", "独居", "与保姆同住", "养老机构"]
EDUCATION = ["小学", "初中", "高中/中专", "大专及以上"]
MARITAL = ["已婚", "丧偶", "离异"]


def load_json(path: pathlib.Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def as_list(payload: Any, key: str) -> list:
    if isinstance(payload, dict) and key in payload:
        return payload[key]
    return payload if isinstance(payload, list) else []


# ---------------------------------------------------------------------------
# 病种与症状
# ---------------------------------------------------------------------------


class Library:
    """疾病库 + 症状词表的只读视图。"""

    def __init__(self) -> None:
        self.diseases = as_list(load_json(DISEASES_PATH), "diseases")
        self.symptoms = as_list(load_json(SYMPTOMS_PATH), "symptoms")
        self.symptom_by_code = {s["code"]: s for s in self.symptoms}
        self.diseases_by_symptom: dict[str, list[dict]] = {}
        for disease in self.diseases:
            for item in disease.get("symptoms", []):
                self.diseases_by_symptom.setdefault(item["code"], []).append(disease)

    def term(self, code: str) -> str:
        return self.symptom_by_code.get(code, {}).get("term", code)

    def synonyms(self, code: str) -> list[str]:
        return list(self.symptom_by_code.get(code, {}).get("synonyms", []))

    def core_symptoms(self, disease: dict) -> list[str]:
        return [s["code"] for s in disease.get("symptoms", []) if s.get("weight") == "core"]

    def secondary_symptoms(self, disease: dict) -> list[str]:
        return [s["code"] for s in disease.get("symptoms", []) if s.get("weight") != "core"]


# ---------------------------------------------------------------------------
# 口语化生成
# ---------------------------------------------------------------------------


class Speaker:
    """把症状编码变成老年人会说的话。

    **口语一律取自词表同义词**——`docs/structured/disease-library/symptoms.json`
    里的同义词本身就是地道的老人口语（"忘事"、"记性差"、"分不清白天黑夜"、
    "起不来"、"排尿费劲"…），而且**必然能被抽取器命中**（后端
    `extract_symptoms()` 就是按「标准词 + 同义词」做子串匹配）。
    自己另造说法反而会让抽取器失准，因此手写口语表只用于生成
    **故意抽不中**的方言/识别噪声样本（见 `unmatched_phrase`）。
    """

    def __init__(self, library: Library, rng: random.Random) -> None:
        self.lib = library
        self.rng = rng

    def base_word(self, code: str) -> str:
        """可被抽取器命中的说法：优先词表同义词，偶尔用标准词。"""
        synonyms = self.lib.synonyms(code)
        term = self.lib.term(code)
        if synonyms and self.rng.random() < 0.85:
            return self.rng.choice(synonyms)
        return term

    def unmatched_phrase(self, code: str) -> str:
        """故意**抽不中**的说法：模拟方言、口音或 ASR 错字。

        用于「特殊交互」组——系统在这类输入上应当**追问澄清**，
        而不是凭猜测给出结论（符合「AI 不诊断、不臆断」的红线）。
        """
        hand_written = UNMATCHABLE.get(code)
        if hand_written:
            return hand_written
        return self.rng.choice(
            [
                "那个…就是那个地方不舒服，说不上来",
                "哎呀，就是那个老毛病犯了",
                "这个怎么说呢，反正就是不得劲",
                "我跟你说不清楚，反正比平时难受",
            ]
        )

    def phrase(self, code: str, severity: str = "moderate") -> str:
        """同一症状的多种说法，随机取一种（保持句子自然且可抽取）。"""
        word = self.base_word(code)
        prefix = self.rng.choice(ONSET_PREFIX)
        adverb = self.rng.choice(DEGREE_ADVERB[severity])
        suffix = self.rng.choice(ELDER_SUFFIX)

        templates = [
            f"{prefix}{word}",
            f"{prefix}{adverb}{word}",
            f"{adverb}，{word}",
            f"{word}{suffix}",
            f"{prefix}{word}{suffix}",
            f"{prefix}{adverb}，{word}",
        ]
        return self.rng.choice(templates)

    def noise(self, base: str, kind: str) -> str:
        """给一句话加口语噪声，模拟语音识别会遇到的干扰。"""
        if kind == "filler":
            return self.rng.choice(["那个，", "嗯……", "这个怎么说呢，", "哎呀，"]) + base
        if kind == "repeat":
            return f"{base}，{base}"
        if kind == "self_correct":
            return base.replace("两天", "三天").replace("有点", "挺厉害").replace("这半个月", "这一个多月")
        if kind == "mishear":
            return "（听不清）" + base
        if kind == "offtopic":
            return base + self.rng.choice(
                [
                    "对了，我那个降压药还有吗？",
                    "我儿子下个礼拜回来。",
                    "哎，你说这医院门口停车难找。",
                ]
            )
        return base


# ---------------------------------------------------------------------------
# 采集意图（与线 A 预问诊流程对齐）
# ---------------------------------------------------------------------------

INTENT_QUESTIONS = {
    "identify": "您好，我是社区医疗的预问诊助手，先问一下您这次主要是哪里不舒服？",
    "chief_complaint": "您说的这些，主要哪个最难受？大概什么时候开始的？",
    "onset": "这个情况是什么时候开始的？是一阵一阵还是一直都有？",
    "symptom_detail": "我再问细一点，您说的这个情况具体是什么样子？",
    "negative": "明白了，我再确认几个：有没有下面这些情况？",
    "associated": "除了刚才说的，还有别的难受吗？",
    "red_flag": "我需要多问两句：有没有出现下面这些情况？",
    "history": "您以前得过什么大病吗？",
    "medication": "现在都在吃什么药？",
    "allergy": "您对什么药或食物过敏吗？",
    "family_history": "家里父母兄弟姐妹有没有类似的情况？",
    "lifestyle": "平时抽烟喝酒吗？",
    "fall_history": "最近半年有没有摔倒过？",
    "functional": "日常生活自己能做到哪一步？",
    "preference": "明白了。最后问一下，如果需要住院或者进一步检查，您这边方便吗？",
}

RED_FLAG_LINES = [
    "有一回直接晕过去了，吓死人了。",
    "胸口那个疼，疼得汗都下来了。",
    "后来人糊涂了，家里人说不认人了。",
]


# ---------------------------------------------------------------------------
# 病史素材
# ---------------------------------------------------------------------------

COMMON_MEDS = {
    "I10": ["苯磺酸氨氯地平 5mg 每日一次", "缬沙坦 80mg 每日一次"],
    "E11": ["二甲双胍 0.5g 每日两次", "格列美脲 1mg 每日一次"],
    "E11.5": ["二甲双胍 0.5g 每日两次", "睡前胰岛素 12 单位"],
    "D64": ["多糖铁复合物 150mg 每日一次"],
    "F32": ["舍曲林 50mg 每日一次"],
    "G20": ["左旋多巴 250mg 每日三次"],
    "G30": ["多奈哌齐 10mg 睡前一次"],
    "F05": ["（未规律用药）"],
    "M17": ["双氯芬酸钠凝胶 外用", "氨糖美辛 疼痛时服"],
    "M05": ["甲氨蝶呤 10mg 每周一次", "泼尼松 5mg 每日一次"],
    "K59": ["乳果糖 15ml 睡前一次"],
    "N40": ["坦索罗辛 2mg 睡前一次"],
    "J44": ["噻托溴铵吸入剂 每日一次", "布地奈德+异丙托溴铵 雾化每日一次"],
    "L89": ["（创面换药 每周 2 次）"],
    "E46": ["肠内营养粉 每次 1 袋 每日三次"],
    "A41": ["（已按医嘱使用抗生素）"],
}

ALLERGIES = [
    "无已知过敏", "青霉素过敏（皮疹）", "磺胺类过敏（皮疹）",
    "海鲜过敏（荨麻疹）", "碘造影剂过敏（皮疹）",
]


# ---------------------------------------------------------------------------
# 生成主流程
# ---------------------------------------------------------------------------

COHORTS = [
    ("clear", 0.60),
    ("vague", 0.75),
    ("red_flag", 0.85),
    ("comorbid", 0.95),
    ("special", 1.01),
]

CASE_INTENT = {
    "clear": "主诉明确，核心症状齐备，期望匹配引擎 Top-1 命中",
    "vague": "仅报告 1~2 个非特异症状，期望 Top-3 内命中并触发追问",
    "red_flag": "高危红旗征象，期望立即就医提醒与人工复核",
    "comorbid": "多病共存，期望给出多个候选并标记冲突交医护复核",
    "special": "沟通受限（耳背/方言/认知障碍/拒答），期望降级与人工兜底",
}

RISK_EXPECT = {
    "immediate": "应触发「立即就医」提醒（红旗路径）",
    "urgent": "应触发「尽快就医」提醒",
    "elective": "应给出择期就诊建议，不应触发急症提醒",
}


def pick_group(index: int, count: int) -> str:
    ratio = index / max(1, count)
    for name, upper in COHORTS:
        if ratio < upper:
            return name
    return "special"


def assign_diseases(library: Library, count: int, rng: random.Random) -> list[dict]:
    """每个病种至少 2 例，剩余按常见度加权。"""
    weight_by_code = {
        "I10": 5.0, "E11": 4.0, "E11.5": 2.0, "M17": 3.0, "M05": 2.0,
        "D64": 2.0, "J44": 2.0, "J18": 1.8, "F32": 1.8, "G20": 1.5,
        "G30": 1.5, "K59": 1.5, "N39": 1.5, "N40": 1.2, "I21": 0.6,
        "I50": 0.8, "E10.3": 0.5, "E14.0": 0.5, "E16.2": 0.5, "A41": 0.8,
        "I63": 0.8, "B02": 0.8, "F05": 0.8, "J69": 0.8, "K56": 0.5,
        "L89": 0.8, "S72.0": 0.8, "E46": 0.8,
    }
    pool: list[dict] = []
    for disease in library.diseases:
        pool.extend([disease] * 2)
    remaining = count - len(pool)
    if remaining > 0:
        weighted: list[dict] = []
        for disease in library.diseases:
            times = int(round(weight_by_code.get(disease["code"], 1.0) * remaining / 10))
            weighted.extend([disease] * times)
        rng.shuffle(weighted)
        pool.extend(weighted[:remaining])
    rng.shuffle(pool)
    return pool[:count]


def build_patient(
    patient_id: str,
    diseases: list[dict],
    group: str,
    library: Library,
    speaker: Speaker,
    rng: random.Random,
) -> dict:
    primary = diseases[0]
    core = library.core_symptoms(primary)
    secondary = library.secondary_symptoms(primary)

    # ---- 症状选取（分组决定信息量）----
    if group == "vague":
        picked = core[: 1 if rng.random() < 0.4 else 2] + secondary[:1]
    elif group == "red_flag":
        picked = core[:3]
        if primary.get("risk_level") == "immediate" and rng.random() < 0.6:
            picked.append("syncope")
    elif group == "comorbid":
        picked = core[:2] + secondary[:1]
    else:
        picked = core[: rng.randint(2, 4)] + secondary[: rng.randint(1, 3)]
    picked = [c for c in dict.fromkeys(picked) if c in library.symptom_by_code]
    if not picked:
        picked = core[:1] or ["fatigue"]

    # ---- 疾病表征 ----
    presentations = []
    for index, code in enumerate(picked):
        severity = "severe" if group == "red_flag" else rng.choice(["mild", "moderate", "moderate", "severe"])
        # 特殊交互组：第一个症状故意用「抽不中」的说法，验证系统会追问而不是臆断
        extractable = not (group == "special" and index == 0)
        expression = (
            speaker.phrase(code, severity)
            if extractable
            else speaker.unmatched_phrase(code)
        )
        presentations.append(
            {
                "symptom_code": code,
                "standard_term": library.term(code),
                "severity": severity,
                "duration": rng.choice(["2 天", "5 天", "1 周", "2 周", "1 个月", "3 个月", "半年以上"]),
                "onset": rng.choice(ONSET_PATTERN),
                "pattern": rng.choice(SYMPTOM_PATTERN),
                "relieving_factor": rng.choice(["休息后缓解", "服药后缓解", "无明显缓解", "改变体位缓解"]),
                "patient_expression": expression,
                "extractable": extractable,
            }
        )

    # ---- 阴性症状（用于检验排除逻辑与「缺失关键症状」证据）----
    negative_pool = [c for c in library.symptom_by_code if c not in picked]
    negatives = [
        {
            "symptom_code": code,
            "standard_term": library.term(code),
            "patient_expression": speaker.phrase(code, "mild"),
        }
        for code in rng.sample(negative_pool, k=min(6, len(negative_pool)))
    ]

    # ---- 干扰病种（共享症状的其他病种）----
    distractors: list[str] = []
    own = {d["code"] for d in diseases}
    for code in picked:
        for other in library.diseases_by_symptom.get(code, []):
            if other["code"] not in own:
                distractors.append(other["code"])
    distractors = list(dict.fromkeys(distractors))[:4]

    # ---- 基本信息 ----
    age = rng.choices(
        [rng.randint(60, 64), rng.randint(65, 74), rng.randint(75, 84), rng.randint(85, 95)],
        weights=[0.08, 0.42, 0.33, 0.17],
    )[0]
    gender = rng.choice(["女", "女", "女", "男", "男"])

    return {
        "synthetic": True,
        "patient_id": patient_id,
        "cohort": group,
        "basic_info": {
            "name": f"测试老人{patient_id[-3:]}",
            "gender": gender,
            "age": age,
            "id_card_masked": f"4401**{rng.randint(10, 99)}**{rng.randint(1000, 9999)}",
            "phone": f"1380000{int(patient_id[-3:]):04d}",
            "address": f"广东省某市某区某街道{rng.randint(1, 40)}号",
            "marital_status": rng.choice(MARITAL),
            "education": rng.choice(EDUCATION),
            "occupation": "退休",
            "living_arrangement": rng.choice(LIVING),
            "language": rng.choice(LANGUAGES),
            "hearing": rng.choice(HEARING),
            "vision": rng.choice(VISION),
            "cognition": rng.choice(COGNITION),
            "hand_function": rng.choice(HAND_FUNCTION),
            "caregiver": rng.choice(["子女", "配偶", "保姆", "无固定照护者"]),
        },
        "medical_history": {
            "conditions": [d["name"] for d in diseases],
            "condition_codes": [d["code"] for d in diseases],
            "other_conditions": rng.sample(
                ["骨质疏松", "白内障术后", "慢性胃炎", "尿路结石", "房颤"], k=rng.randint(0, 2)
            ),
            "surgery_history": rng.choice(
                ["无", "无", "阑尾切除术（30 年前）", "胆囊切除术（10 年前）", "髋关节置换术（3 年前）"]
            ),
            "medications": COMMON_MEDS.get(primary["code"], ["（无长期用药）"]),
            "allergy": rng.choice(ALLERGIES),
            "family_history": rng.choice(
                ["父亲有高血压", "母亲有糖尿病", "父母均有高血压", "无明显家族史", "兄长有脑卒中史"]
            ),
            "lifestyle": {
                "smoking": rng.choice(["已戒烟 20 年", "从不吸烟", "已戒烟 10 年"]),
                "drinking": rng.choice(["不饮酒", "偶尔饮酒", "已戒酒 5 年"]),
                "exercise": rng.choice(["每天散步", "很少运动", "偶尔活动一下"]),
                "fall_history": rng.choice(["近一年无跌倒", "近半年跌倒 1 次", "近一年跌倒 2 次"]),
                "sleep": rng.choice(["入睡困难", "易醒", "基本正常"]),
            },
        },
        "disease_presentation": {
            "chief_complaint": {
                "text": presentations[0]["patient_expression"],
                "site": rng.choice(["头面部", "胸部", "腹部", "腰背部", "四肢", "全身"]),
                "nature": rng.choice(["胀痛", "紧缩感", "钝痛", "无力", "不适"]),
                "associated": "、".join(p["patient_expression"] for p in presentations[1:3]),
                "onset": presentations[0]["onset"],
            },
            "symptoms": presentations,
            "negative_symptoms": negatives,
        },
        "expected_disease": {
            "note": "测试断言基准，不是系统输出；系统侧禁止输出诊断结论",
            "primary": {
                "code": primary["code"],
                "name": primary["name"],
                "risk_level": primary.get("risk_level", ""),
                "expectation": RISK_EXPECT.get(primary.get("risk_level", ""), ""),
            },
            "secondary": [
                {"code": d["code"], "name": d["name"], "risk_level": d.get("risk_level", ""), "co_present": True}
                for d in diseases[1:]
            ],
            "should_hit_core_symptoms": core,
            "distractor_disease_codes": distractors,
            "expected_top1": group != "vague",
            "expected_top3": True,
            "review_required": group in ("red_flag", "comorbid", "special"),
            "case_intent": CASE_INTENT.get(group, ""),
        },
    }


def build_dialogue(patient: dict, library: Library, speaker: Speaker, rng: random.Random) -> dict:
    """按采集意图生成医患仿真对话。"""
    turns: list[dict] = []
    seq = 0

    def add(role: str, intent: str, text: str, **extra: Any) -> None:
        nonlocal seq
        seq += 1
        turns.append({"seq": seq, "role": role, "intent": intent, "text": text, **extra})

    group = patient["cohort"]
    presentations = patient["disease_presentation"]["symptoms"]
    negatives = patient["disease_presentation"]["negative_symptoms"]
    history = patient["medical_history"]

    add("nurse", "identify", INTENT_QUESTIONS["identify"])
    add(
        "patient",
        "chief_complaint",
        speaker.noise(patient["disease_presentation"]["chief_complaint"]["text"], "filler"),
        noise=["filler"],
    )

    # 症状细节：逐个症状一问一答
    for index, item in enumerate(presentations):
        add("nurse", "symptom_detail", INTENT_QUESTIONS["symptom_detail"])
        extractable = item.get("extractable", True)
        kind = "mishear" if not extractable else "self_correct"
        add(
            "patient",
            "symptom_detail",
            speaker.noise(item["patient_expression"], kind),
            symptom_code=item["symptom_code"],
            severity=item["severity"],
            expect_extraction=extractable,
            noise=[kind],
        )
        if index == 0:
            add("nurse", "onset", INTENT_QUESTIONS["onset"])
            add(
                "patient",
                "onset",
                f"{item['duration']}了，{item['onset']}，{item['pattern']}，{item['relieving_factor']}。",
                noise=[],
            )

    # 阴性症状（排除信息）
    if negatives:
        add("nurse", "negative", INTENT_QUESTIONS["negative"])
        add(
            "patient",
            "negative",
            "；".join(f"没有{n['patient_expression']}" for n in negatives[:3]) + "。",
            negative_symptom_codes=[n["symptom_code"] for n in negatives[:3]],
            noise=[],
        )

    add("nurse", "associated", INTENT_QUESTIONS["associated"])
    add(
        "patient",
        "associated",
        "别的倒没啥，" + rng.choice(["就是人容易累。", "就是胃口差点。", "晚上要起来两趟。"]),
        noise=[],
    )

    if group == "red_flag":
        add("nurse", "red_flag", INTENT_QUESTIONS["red_flag"])
        add("patient", "red_flag", rng.choice(RED_FLAG_LINES), red_flag=True, noise=[])

    add("nurse", "history", INTENT_QUESTIONS["history"])
    add(
        "patient",
        "history",
        f"{'、'.join(history['conditions'])}这些老毛病都有，{'、'.join(history['other_conditions']) or '别的倒没有'}。",
        noise=[],
    )
    add("nurse", "medication", INTENT_QUESTIONS["medication"])
    add("patient", "medication", "、".join(history["medications"]) + "，天天吃着呢。", noise=[])
    add("nurse", "allergy", INTENT_QUESTIONS["allergy"])
    add("patient", "allergy", history["allergy"], noise=[])

    if group != "special":
        add("nurse", "family_history", INTENT_QUESTIONS["family_history"])
        add("patient", "family_history", history["family_history"], noise=[])
        add("nurse", "lifestyle", INTENT_QUESTIONS["lifestyle"])
        add(
            "patient",
            "lifestyle",
            f"{history['lifestyle']['smoking']}，{history['lifestyle']['drinking']}。",
            noise=[],
        )
        add("nurse", "fall_history", INTENT_QUESTIONS["fall_history"])
        add("patient", "fall_history", history["lifestyle"]["fall_history"], noise=[])

    add("nurse", "functional", INTENT_QUESTIONS["functional"])
    add(
        "patient",
        "functional",
        rng.choice(
            [
                "吃饭穿衣还能自理，出门要拄拐。",
                "自己做饭没问题，就是上下楼费劲。",
                "得有人帮着洗澡，其他还行。",
            ]
        ),
        noise=[],
    )
    add("nurse", "preference", INTENT_QUESTIONS["preference"])
    add(
        "patient",
        "preference",
        rng.choice(
            [
                "住得远，儿女在外地，能不能先在社区看看。",
                "要住院我得跟儿女商量商量。",
                "方便的话下午来都行。",
            ]
        ),
        noise=[],
    )

    if group == "special":
        add(
            "patient",
            "offtopic",
            speaker.noise("对了医生，我那降压药今天还没吃呢。", "offtopic"),
            noise=["offtopic"],
        )

    return {
        "patient_id": patient["patient_id"],
        "cohort": group,
        "language": patient["basic_info"]["language"],
        "hearing": patient["basic_info"]["hearing"],
        "turn_count": len(turns),
        "turns": turns,
    }


def build_scale_answers(patient: dict, rng: random.Random) -> list[dict]:
    """按真值病种推导典型量表作答（用于施测端到端流程）。"""
    answers: list[dict] = []
    code = patient["expected_disease"]["primary"]["code"]
    risk = patient["expected_disease"]["primary"]["risk_level"]

    def add(scale_code: str, note: str, value: Any) -> None:
        answers.append({"scale_code": scale_code, "note": note, "answer": value})

    if code == "S72.0":
        add("B.9", "居家环境存在跌倒风险项", {"risk_items": ["地面湿滑", "无扶手", "照明不足"]})
        add("B.3", "简易体能：跌倒后步速与起立能力下降", {"score": 6})
    if code in {"G30", "F05", "E46", "M17", "K59"}:
        add("B.19", "营养/认知筛查提示异常", {"score": 14})
    if code in {"G20", "M17", "M05", "S72.0"}:
        add("B.3", "体能与平衡下降", {"score": 7})
    if code in {"I21", "I50", "I10", "E10.3", "E14.0"}:
        add("B.18", "疼痛评分与主诉一致", {"score": 3})
    if code in {"N39", "N40"}:
        add("B.11", "尿失禁问卷应答", {"score": 4})
    if code == "J44":
        add("B.1", "肺功能与活动耐量下降", {"score": 18})
    if code == "L89":
        add("B.9", "居家环境与照护能力评估", {"risk_items": ["长期卧床", "翻身困难"]})
        add("B.2", "基础日常生活活动受限", {"score": 45})
    if code in {"B02", "F32"}:
        add("B.14", "疼痛评分", {"score": 4})
    if code in {"A41", "E16.2", "E10.3"}:
        add("B.21", "意识与谵妄条目需人工确认", {"score": 3})

    if not answers:
        add("B.1", "常规基线量表", {"score": 25})
    for item in answers:
        item["expected_risk_note"] = "立即就医" if risk == "immediate" else "常规"
    return answers


def main() -> int:
    parser = argparse.ArgumentParser(description="生成模拟患者测试数据集")
    parser.add_argument("--count", type=int, default=DEFAULT_COUNT)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--out", type=str, default=str(OUT_DIR))
    args = parser.parse_args()

    rng = random.Random(args.seed)
    library = Library()
    speaker = Speaker(library, rng)
    out_dir = pathlib.Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    disease_assignments = assign_diseases(library, args.count, rng)

    patients: list[dict] = []
    dialogues: list[dict] = []
    scale_answers: list[dict] = []

    for index in range(args.count):
        patient_id = f"SP{index + 1:03d}"
        group = pick_group(index, args.count)
        diseases = [disease_assignments[index]]
        if group == "comorbid":
            others = [d for d in library.diseases if d["code"] != diseases[0]["code"]]
            diseases.append(rng.choice(others))
        patient = build_patient(patient_id, diseases, group, library, speaker, rng)
        patients.append(patient)
        dialogues.append(build_dialogue(patient, library, speaker, rng))
        scale_answers.append(
            {"patient_id": patient_id, "answers": build_scale_answers(patient, rng)}
        )

    (out_dir / "patients.json").write_text(
        json.dumps(
            {
                "synthetic": True,
                "count": len(patients),
                "seed": args.seed,
                "source": {
                    "diseases": "docs/structured/disease-library/diseases.json",
                    "symptoms": "docs/structured/disease-library/symptoms.json",
                    "scales": "docs/structured/assessment-scales/",
                },
                "patients": patients,
            },
            ensure_ascii=False,
            indent=1,
        ),
        encoding="utf-8",
    )

    with (out_dir / "dialogues.jsonl").open("w", encoding="utf-8") as handle:
        for dialogue in dialogues:
            handle.write(json.dumps(dialogue, ensure_ascii=False) + "\n")

    (out_dir / "scale_answers.json").write_text(
        json.dumps({"synthetic": True, "answers": scale_answers}, ensure_ascii=False, indent=1),
        encoding="utf-8",
    )

    cohort_counter: dict[str, int] = {}
    disease_counter: dict[str, int] = {}
    risk_counter: dict[str, int] = {}
    symptom_counter: dict[str, int] = {}
    for patient in patients:
        cohort_counter[patient["cohort"]] = cohort_counter.get(patient["cohort"], 0) + 1
        primary = patient["expected_disease"]["primary"]
        disease_counter[primary["name"]] = disease_counter.get(primary["name"], 0) + 1
        risk_counter[primary["risk_level"]] = risk_counter.get(primary["risk_level"], 0) + 1
        for item in patient["disease_presentation"]["symptoms"]:
            symptom_counter[item["symptom_code"]] = symptom_counter.get(item["symptom_code"], 0) + 1
        for item in patient["disease_presentation"]["negative_symptoms"]:
            symptom_counter[item["symptom_code"]] = symptom_counter.get(item["symptom_code"], 0) + 1

    turn_total = sum(d["turn_count"] for d in dialogues)
    summary = {
        "synthetic": True,
        "count": len(patients),
        "seed": args.seed,
        "cohorts": cohort_counter,
        "by_risk_level": risk_counter,
        "by_disease": dict(sorted(disease_counter.items(), key=lambda kv: -kv[1])),
        "symptoms_used": len(symptom_counter),
        "symptom_vocabulary_total": len(library.symptoms),
        "dialogue_turns_total": turn_total,
        "dialogue_turns_avg": round(turn_total / max(1, len(dialogues)), 1),
        "scale_answer_sets": len(scale_answers),
    }
    (out_dir / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    print(json.dumps(summary, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
