"""检查鉴别要点（differentials.features）的语义方向是否统一。

引擎语义（backend/app/services/matching.py）：
    仅当 features 中**一个都没命中**时，才对本病施加负向扣分。
    因此 features 必须写「**本病自身的鉴别性特征**」：
    命中 → 支持本病；全不命中 → 本病证据不足，扣分。

本脚本统计全库中 features 与本病自身症状的交集情况，用于发现方向写反的条目。
"""

from __future__ import annotations

import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
LIB = ROOT / "docs" / "structured" / "disease-library"


def check(path: pathlib.Path, label: str) -> tuple[int, int]:
    data = json.loads(path.read_text(encoding="utf-8"))
    total = 0
    suspect = 0
    for disease in data.get("diseases", []):
        own = {item["code"] for item in disease.get("symptoms", [])}
        for differential in disease.get("differentials", []):
            total += 1
            features = set(differential.get("features", []))
            if features and not (features & own):
                suspect += 1
                print(
                    f"  [方向存疑] {label} {disease['code']} vs {differential.get('vs_code')}"
                    f" features={sorted(features)} 本病症状={sorted(own)}"
                )
    return total, suspect


def main() -> int:
    print("=" * 60)
    for name in ("_disease.example.json", "diseases.json"):
        path = LIB / name
        if not path.exists():
            continue
        total, suspect = check(path, name)
        print(f"{name}: 鉴别条目 {total} 条，方向存疑 {suspect} 条")
    print("=" * 60)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
