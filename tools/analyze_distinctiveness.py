"""疾病库区分度分析：哪些症状是「独有线索」，哪些是「共享症状」。

回答两个问题：
1. 哪些症状出现在很多病种里（区分度低，命中它说明不了太多问题）？
2. 哪些症状只出现在一两个病种里（区分度高，是真正的鉴别线索）？

用法：python tools/analyze_distinctiveness.py
"""

from __future__ import annotations

import json
import pathlib
from collections import defaultdict

ROOT = pathlib.Path(__file__).resolve().parents[1]
LIB = ROOT / "docs" / "structured" / "disease-library"


def main() -> int:
    library = json.loads((LIB / "diseases.json").read_text(encoding="utf-8"))
    vocabulary = {
        item["code"]: item.get("term", item["code"])
        for item in json.loads((LIB / "symptoms.json").read_text(encoding="utf-8"))["symptoms"]
    }
    diseases = library["diseases"]

    owners: dict[str, list[str]] = defaultdict(list)
    for disease in diseases:
        for symptom in disease.get("symptoms", []):
            owners[symptom["code"]].append(disease["code"])

    total = len(diseases)
    print(f"病种数 {total}｜被引用的症状 {len(owners)} 个（词表 {len(vocabulary)} 条）")
    print()

    shared = sorted(
        ((code, sorted(set(names))) for code, names in owners.items() if len(set(names)) >= 5),
        key=lambda item: -len(item[1]),
    )
    print("【区分度低】出现在 ≥5 个病种的症状（命中它说明不了太多问题）")
    for code, names in shared:
        print(f"  {vocabulary.get(code, code):<14} {code:<28} 见于 {len(names)} 个病种：{'、'.join(names)}")
    print()

    unique = sorted(
        ((code, sorted(set(names))) for code, names in owners.items() if len(set(names)) <= 2),
        key=lambda item: len(item[1]),
    )
    print("【区分度高】只出现在 ≤2 个病种的症状（真正的鉴别线索）")
    for code, names in unique:
        print(f"  {vocabulary.get(code, code):<14} {code:<28} 见于 {len(names)} 个病种：{'、'.join(names)}")

    print()
    uncovered = sorted(set(vocabulary) - set(owners))
    if uncovered:
        print(f"【未使用】词表中还没有被任何病种引用的症状（{len(uncovered)} 条）：")
        for code in uncovered:
            print(f"  {vocabulary.get(code, code):<14} {code}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
