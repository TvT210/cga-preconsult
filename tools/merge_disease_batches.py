"""合并疾病库批次文件 → diseases.json（schema v2）。

用法：
    python tools/merge_disease_batches.py            # 合并并校验
    python tools/merge_disease_batches.py --check    # 只校验批次，不写入

合并规则：
- 以批次文件为准（同 code 覆盖旧条目），批次外的旧条目一并保留（若有则告警）；
- 顶层 version 升到 0.2.0-draft，review_status 保持待评审；
- 合并后强制跑一遍校验器，任何错误直接返回非零退出码。
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
LIBRARY = ROOT / "docs" / "structured" / "disease-library"
TARGET = LIBRARY / "diseases.json"
BATCHES = [LIBRARY / "_batch_a.json", LIBRARY / "_batch_b.json"]

TOP_NOTE = (
    "老年易发疾病信息库（schema v2）。symptoms / red_flags / protective_signs / "
    "differentials.features 引用的 code 全部来自 symptoms.json 受控词表。"
    "risk_factors 为高危因素（可带 code 供引擎自动匹配，不带 code 则仅作医护参考）；"
    "red_flags 命中时提醒等级托底不降级；protective_signs 命中时直接削弱本病可能性。"
    "本库为草稿，未经医学专家评审不得用于正式临床提醒。"
)


def load(path: pathlib.Path):
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def main() -> int:
    parser = argparse.ArgumentParser(description="合并疾病库批次")
    parser.add_argument("--check", action="store_true", help="只校验，不写入 diseases.json")
    args = parser.parse_args()

    missing = [str(path) for path in BATCHES if not path.exists()]
    if missing:
        print(f"缺少批次文件：{missing}")
        return 1

    merged: dict[str, dict] = {}
    for path in BATCHES:
        batch = load(path)
        for disease in batch.get("diseases", []):
            code = disease.get("code")
            if not code:
                print(f"[{path.name}] 存在无 code 的条目，已跳过")
                continue
            if code in merged:
                print(f"[{path.name}] code 重复：{code}，后者覆盖前者")
            merged[code] = disease

    # 批次间别名冲突
    owner: dict[str, str] = {}
    conflicts: list[str] = []
    for code, disease in merged.items():
        for alias in [disease.get("name", "")] + list(disease.get("aliases") or []):
            if not alias:
                continue
            if alias in owner and owner[alias] != code:
                conflicts.append(f"「{alias}」同时属于 {owner[alias]} 与 {code}")
            else:
                owner[alias] = code
    for item in conflicts:
        print(f"[冲突] {item}")

    print(f"合并后病种数：{len(merged)}")
    if conflicts:
        print("存在别名冲突，请先修正批次文件")
        return 1

    # 写入
    target = load(TARGET) if TARGET.exists() else {}
    target["version"] = "0.2.0-draft"
    target["review_status"] = target.get("review_status", "draft_pending_medical_review")
    target["note"] = TOP_NOTE
    target["diseases"] = [merged[code] for code in sorted(merged.keys(), key=lambda item: (item[0].isalpha(), item))]

    if not args.check:
        TARGET.write_text(json.dumps(target, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"已写入 {TARGET}")

    # 校验
    sys.path.insert(0, str(ROOT / "tools"))
    from validate_disease_library import validate  # noqa: E402

    errors, warnings, stats = validate()
    print("-" * 60)
    for key, value in stats.items():
        print(f"  {key}: {value}")
    print(f"错误 {len(errors)} 项 / 警告 {len(warnings)} 项")
    for item in errors:
        print(f"  [ERROR] {item}")
    for item in warnings[:20]:
        print(f"  [WARN ] {item}")
    if len(warnings) > 20:
        print(f"  … 其余 {len(warnings) - 20} 条警告省略")
    print("=" * 60)
    if errors:
        print("结论：合并后校验不通过")
        return 1
    print("结论：合并后校验通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
