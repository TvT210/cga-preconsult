"""抽查疾病库内容质量（人工审校用）。"""

from __future__ import annotations

import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
LIB = ROOT / "docs" / "structured" / "disease-library"

codes = sys.argv[1:] or ["K56", "S72.0", "E11.5", "I63"]
data = json.loads((LIB / "diseases.json").read_text(encoding="utf-8"))

for code in codes:
    matched = [item for item in data["diseases"] if item["code"] == code]
    if not matched:
        print(f"未找到 {code}")
        continue
    item = matched[0]
    print("=" * 25, code, item["name"], "=" * 25)
    print("别名:", item["aliases"], "| 风险:", item["risk_level"], "| 系统:", item["system"])
    print("症状:", ", ".join(f"{s['code']}({s['weight']})" for s in item["symptoms"]))
    print("红旗:", " | ".join(f"{r['term']}：{r['note'][:40]}" for r in item.get("red_flags", [])))
    print("保护征:", " | ".join(f"{p['term']}：{p['note'][:40]}" for p in item.get("protective_signs", [])))
    print("鉴别:")
    for differential in item["differentials"]:
        print("   vs", differential["vs_code"], differential["points"], "|", differential["reason"][:70])
    print("高危因素:")
    for factor in item["risk_factors"]:
        print("   -", factor["factor"], "|", factor["detail"][:64])
    print("非典型表现:")
    for text in item["atypical_presentations"]:
        print("   *", text)
    print("量表关联:", [(link["scale"], link["item"]) for link in item["scale_links"]])
    print("建议:", item["advice"]["department"], "|", item["advice"]["urgency"])
    print("   ", item["advice"]["text"])
    print("来源:", item["source"])
    print()
