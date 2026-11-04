"""疾病库与词表的一致性补齐（**线 B**：结论与运营）。

两件事：
1. 给受控词表补充**鉴别性追问话术（probe）**——优先补线 A 新增的量表条目所引入的词条，
   以及疾病库高频引用但尚无 probe 的词条；
2. 量表条目补录后，把疾病库的 `scale_links` 从「空题号」补成**真实题号**，
   使报告里的「建议加做哪张量表 / 关注哪一项」可落到具体题目。

用法：
    python tools/enrich_disease_library.py            # 写入
    python tools/enrich_disease_library.py --check    # 只看差异
"""

from __future__ import annotations

import argparse
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
LIBRARY = ROOT / "docs" / "structured" / "disease-library"
SYMPTOMS = LIBRARY / "symptoms.json"
DISEASES = LIBRARY / "diseases.json"

# ---------------------------------------------------------------------------
# 1) 鉴别性追问话术（用于 AI 复核层生成「该问什么」）
# ---------------------------------------------------------------------------

PROBES: dict[str, str] = {
    # 线 A 新增量表条目带来的新词条
    "vision_impairment": "看东西是模糊、看不清，还是突然看不见了？戴眼镜能改善吗？",
    "visual_field_deficit": "是不是像有一块黑布挡住了视野？走路会不会撞到东西？",
    "hearing_impairment": "是听不清说话声，还是听不清大声说话？需要贴很近才听得见吗？",
    "home_environment_hazard": "家里最近有没有摔过跤的地方？浴室、楼梯、走廊的扶手和照明怎么样？",
    "cognitive_impairment": "是最近突然变差的，还是一点点慢慢变差的？家里人发现了吗？",
    "attention_deficit": "说话能听明白吗？能不能跟上一件事、回答问题？",
    "thought_disorder": "说的话能不能听明白前后连贯？有没有答非所问？",
    "consciousness_decreased": "现在是清醒还是有点迷糊？叫她/他能应吗？",
    # 疾病库高频引用但此前缺 probe 的词条
    "fall_history": "最近一次摔倒是什么时候？有没有磕到头或者髋部？",
    "gait_slow": "走一百米大概要多久？和半年前比是不是慢了？",
    "gait_instability": "走路要不要扶东西？转弯、上下楼有没有站不稳？",
    "muscle_weakness": "拧瓶盖、提东西有力气吗？有没有拿不稳、抬不起胳膊的情况？",
    "muscle_mass_loss": "小腿是不是比以前细了？袖口是不是变松了？",
    "difficulty_walking": "平地上走一百米要不要歇？有没有走一段就得停一下？",
    "chair_transfer_difficulty": "从椅子站起来费不费劲？要不要撑着扶手？",
    "bed_transfer_difficulty": "在床上翻身、坐起来要人帮忙吗？",
    "bathing_difficulty": "洗澡是自己洗还是别人帮忙？会不会滑倒？",
    "dressing_difficulty": "穿衣服扣扣子、穿鞋费不费劲？",
    "toileting_difficulty": "上厕所是自己去还是要人扶？有没有弄脏裤子？",
    "feeding_difficulty": "吃饭要不要人喂？嚼得动吗？会不会呛？",
    "continence_urinary": "漏尿是偶尔还是经常？漏的时候自己知道吗？",
    "continence_fecal": "大便能不能控制住？漏出来过吗？",
    "urinary_frequency": "白天大概要尿几次？夜里起夜几次？",
    "low_bmi": "身高体重量过吗？最近半年瘦了多少？",
    "fracture_history": "哪一年、哪个部位骨折过？有没有做过手术？",
    "pain_chronic": "这个疼有多久了？是一直疼还是一阵一阵？影响睡觉和走路吗？",
    "unilateral_leg_swelling": "是一条腿肿还是两条腿？早上和下午比有没有变化？",
    "hallucination": "看到的是不存在的人还是声音？能自己意识到吗？",
    "depression": "最近有没有觉得没意思、提不起劲？睡眠怎么样？",
    "anxiety": "是经常担心害怕，还是心里发慌？会不会因此睡不着？",
    "insomnia": "上床要多久能睡着？夜里醒几次？早上几点醒？",
    "nocturnal_awakening": "夜里醒是因为上厕所、疼，还是心里烦？",
    "social_isolation": "平时多久能跟人说上话？有没有人陪着吃饭、聊天？",
    "caregiver_burden": "照顾他现在累不累？有没有请过人？夜里谁管？",
    "poor_sleep_quality": "一晚上大概睡几个小时？醒了以后精神好不好？",
    "low_activity": "现在还出去走走吗？每天大概活动多久？",
    "polyuria": "小便次数多、量也多吗？夜里要起来几次？",
    "polypharmacy": "现在一共吃几种药？每天都要吃几种？",
    "hyperglycemia_symptom": "有没有口渴、想喝水、总想上厕所？",
    "foot_ulcer": "脚上有伤口吗？多久了？有没有红肿、流水？",
    "vision_decline": "看东西模糊多久了？戴老花镜能看清吗？",
    "hearing_decline": "需要别人重复几遍才听得见？电视要开多大声？",
    "home_safety_risk": "家里地上有没有杂物、楼梯有没有扶手、夜里灯亮不亮？",
    "medication_nonadherence": "药是按时吃还是想起来才吃？有没有自己停过药？",
    "dehydration": "一天喝几杯水？嘴唇干不干？尿少不少？",
    "anemia_symptom": "有没有觉得乏力、爬楼喘、脸色发白？有没有黑便？",
    "cachexia": "半年瘦了多少？原来能穿的裤子现在还能穿吗？",
    "nausea_vomiting": "吐过几次？是早上吐还是饭后吐？吐的是什么？",
    "edema_heart": "腿是早上肿还是晚上肿？平躺一晚能消下去吗？",
    "orthostatic_hypotension": "从床上或椅子上猛地站起来，会不会眼前发黑、要扶东西？",
    "daytime_somnolence": "白天是不是总打瞌睡？有没有坐着就睡着了？",
    "weight_bearing_pain": "走路时疼还是坐下时疼？上下楼疼不疼？",
    "joint_pain": "哪个关节？活动时疼还是不动也疼？早上起来僵不僵？",
    "dementia_daily_function": "现在能自己穿衣、吃饭、上厕所吗？哪一项开始做不了了？",
    "repetitive_questioning": "是不是同一个问题反复问？问了多久了？",
    "night_wandering": "夜里有没有乱走？会不会走丢？",
}

# ---------------------------------------------------------------------------
# 2) 疾病库 scale_links 的真实题号（量表条目补录后才有意义）
# ---------------------------------------------------------------------------

# (疾病 code, 量表 code) → 题号
ITEM_MAP: dict[tuple[str, str], str] = {
    # 谵妄 / 意识改变相关
    ("A41", "B.21"): "B21-05",
    ("B02", "B.15"): "B15-01",
    ("E10.3", "B.21"): "B21-05",
    ("E14.0", "B.21"): "B21-05",
    ("E14.0", "B.8"): "B8-01",
    ("E16.2", "B.21"): "B21-03",
    ("F05", "B.21"): "B21-01",
    ("F05", "B.12"): "B12-03",
    ("J18", "B.21"): "B21-05",
    ("J69", "B.21"): "B21-05",
    ("K56", "B.21"): "B21-05",
    # 体能 / 平衡 / 步态
    ("E11.5", "B.3"): "B3-04",
    ("G20", "B.3"): "B3-05",
    ("I10", "B.3"): "B3-04",
    ("I21", "B.3"): "B3-05",
    ("I63", "B.3"): "B3-01",
    ("M17", "B.3"): "B3-05",
    # 认知
    ("G30", "B.8"): "B8-03",
    ("I63", "B.8"): "B8-01",
    # 居家与排尿
    ("G30", "B.9"): "B9-05",
    ("K59", "B.12"): "B12-03",
    ("N39", "B.11"): "B11-04",
    ("N40", "B.11"): "B11-01",
    # 吞咽
    ("J69", "B.17"): "B17-01",
}

# 需要**新增**的量表关联（疾病 code, 量表 code, 题号, 说明）
NEW_LINKS: list[tuple[str, str, str, str]] = [
    ("E46", "B.20", "B20-01", "GLIM 营养不良诊断：体重减轻与肌量减少的判定"),
    ("S72.0", "B.9", "B9-03", "居家环境筛查：地面防滑与跌倒风险"),
]


def main() -> int:
    parser = argparse.ArgumentParser(description="补齐疾病库与词表")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()

    symptoms = json.loads(SYMPTOMS.read_text(encoding="utf-8"))
    diseases = json.loads(DISEASES.read_text(encoding="utf-8"))

    added_probes = []
    for item in symptoms["symptoms"]:
        probe = PROBES.get(item["code"])
        if probe and not item.get("probe"):
            item["probe"] = probe
            added_probes.append(item["code"])

    filled_items = []
    new_links = []
    for disease in diseases["diseases"]:
        code = disease["code"]
        for link in disease.get("scale_links", []):
            key = (code, link.get("scale", ""))
            if not link.get("item") and key in ITEM_MAP:
                link["item"] = ITEM_MAP[key]
                filled_items.append(f"{code}/{key[1]}→{ITEM_MAP[key]}")
        existing = {(link.get("scale"), link.get("item")) for link in disease.get("scale_links", [])}
        for disease_code, scale, item, note in NEW_LINKS:
            if disease_code == code and (scale, item) not in existing:
                disease.setdefault("scale_links", []).append(
                    {"scale": scale, "item": item, "note": note}
                )
                new_links.append(f"{code}/{scale}→{item}")

    print(f"新增 probe 话术 {len(added_probes)} 条：{added_probes}")
    print(f"补齐真实题号 {len(filled_items)} 处：{filled_items}")
    print(f"新增量表关联 {len(new_links)} 处：{new_links}")

    if args.check:
        print("（--check 模式，未写盘）")
        return 0

    symptoms["version"] = "0.3.0-draft"
    SYMPTOMS.write_text(json.dumps(symptoms, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    DISEASES.write_text(json.dumps(diseases, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"已写入 {SYMPTOMS}")
    print(f"已写入 {DISEASES}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
