"""为疾病库补写「症状组合模式」（patterns）。

医生初诊看的是**症状组合**而非单个症状，例如「胸痛 + 气促 + 心悸」提示急性心肌缺血，
而「胸痛 + 发热 + 咳嗽」提示肺部感染。引擎据此给组合命中额外加分（协同证据）。

用法：
    python tools/add_disease_patterns.py            # 写入批次文件并合并
    python tools/add_disease_patterns.py --check    # 只看会改动什么

组合中的症状 code 必须来自 symptoms.json 受控词表。
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
LIBRARY = ROOT / "docs" / "structured" / "disease-library"

# 病种 → 症状组合模式
PATTERNS: dict[str, list[dict]] = {
    "I21": [
        {
            "symptoms": ["chest_pain", "dyspnea", "palpitations"],
            "bonus": 3.0,
            "note": "胸痛 + 气促 + 心悸同时出现，提示急性心肌缺血（老年人可仅表现为气促与心慌）",
        }
    ],
    "I63": [
        {
            "symptoms": ["orientation_deficit", "dysarthria", "muscle_weakness"],
            "bonus": 3.0,
            "note": "意识改变 + 言语含糊 + 肢体无力组合，提示局灶性神经功能缺损",
        }
    ],
    "J18": [
        {
            "symptoms": ["cough", "sputum", "fever"],
            "bonus": 3.0,
            "note": "咳嗽 + 咳痰 + 发热组合，为典型呼吸道感染表现",
        }
    ],
    "E10.3": [
        {
            "symptoms": ["hyperglycemia_symptom", "deep_breathing", "nausea_vomiting"],
            "bonus": 3.0,
            "note": "高血糖 + 深大呼吸 + 恶心呕吐组合，提示酮症酸中毒的代偿表现",
        }
    ],
    "E16.2": [
        {
            "symptoms": ["hypoglycemia_symptom", "tremor", "delirium_fluctuation"],
            "bonus": 3.0,
            "note": "心慌手抖 + 意识波动组合，提示低血糖发作（易被误认为谵妄）",
        }
    ],
    "K56": [
        {
            "symptoms": ["abdominal_pain", "abdominal_distension", "no_flatus_or_defecation"],
            "bonus": 3.0,
            "note": "腹痛 + 腹胀 + 停止排气排便组合，提示机械性肠梗阻",
        }
    ],
    "S72.0": [
        {
            "symptoms": ["fall_injury", "hip_pain", "limb_deformity"],
            "bonus": 3.0,
            "note": "跌倒 + 髋部疼痛 + 患肢畸形组合，提示股骨颈骨折",
        }
    ],
    "A41": [
        {
            "symptoms": ["fever", "orientation_deficit", "dehydration"],
            "bonus": 3.0,
            "note": "发热 + 意识改变 + 脱水组合，提示感染性谵妄与脓毒症",
        }
    ],
}


def main() -> int:
    parser = argparse.ArgumentParser(description="补写疾病症状组合模式")
    parser.add_argument("--check", action="store_true", help="只检查不写入")
    args = parser.parse_args()

    vocabulary = {
        item["code"]
        for item in json.loads((LIBRARY / "symptoms.json").read_text(encoding="utf-8"))["symptoms"]
    }

    errors: list[str] = []
    for code, patterns in PATTERNS.items():
        for pattern in patterns:
            for symptom in pattern["symptoms"]:
                if symptom not in vocabulary:
                    errors.append(f"{code} 组合引用了词表外的症状码：{symptom}")

    # 写回批次文件（批��是疾病库的内容源头）
    for batch_name in ("_batch_a.json", "_batch_b.json"):
        path = LIBRARY / batch_name
        if not path.exists():
            continue
        batch = json.loads(path.read_text(encoding="utf-8"))
        changed = 0
        for disease in batch.get("diseases", []):
            code = disease.get("code")
            if code in PATTERNS:
                disease["patterns"] = PATTERNS[code]
                changed += 1
        print(f"{batch_name}: 写入 {changed} 个病种的 patterns")
        if not args.check:
            path.write_text(json.dumps(batch, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    for item in errors:
        print(f"[ERROR] {item}")
    if errors:
        return 1

    if args.check:
        print("（--check 模式，未写盘）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
