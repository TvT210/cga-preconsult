"""合并症状词条提案 → symptoms.json（线 B 拥有词条本体）。

用法：
    python tools/merge_symptom_proposal.py            # 合并
    python tools/merge_symptom_proposal.py --check    # 只检查

原则：
- 只**追加**词条，不修改、不删除任何现有词条；
- 提案词条与现有词条 code 冲突时跳过并报错（避免静默覆盖医学口径）；
- 合并后自动跑疾病库校验。
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
LIB = ROOT / "docs" / "structured" / "disease-library"
TARGET = LIB / "symptoms.json"
PROPOSAL = LIB / "_symptoms.proposed.json"


def main() -> int:
    parser = argparse.ArgumentParser(description="合并症状词条提案")
    parser.add_argument("--check", action="store_true", help="只检查不写入")
    args = parser.parse_args()

    if not PROPOSAL.exists():
        print(f"未找到提案文件：{PROPOSAL}")
        return 1

    target = json.loads(TARGET.read_text(encoding="utf-8"))
    proposal = json.loads(PROPOSAL.read_text(encoding="utf-8"))

    existing = {item["code"] for item in target["symptoms"]}
    added: list[str] = []
    conflicts: list[str] = []

    for item in proposal.get("symptoms", []):
        code = item.get("code")
        if not code:
            conflicts.append("提案存在无 code 的词条")
            continue
        if code in existing:
            conflicts.append(f"code 已存在，跳过：{code}")
            continue
        if any(term in existing for term in []):  # 保留结构
            pass
        target["symptoms"].append(
            {
                "code": code,
                "term": item.get("term", code),
                "category": item.get("category", ""),
                "synonyms": item.get("synonyms", []) or [],
            }
        )
        existing.add(code)
        added.append(code)

    print(f"现有词条 {len(target['symptoms']) - len(added)} 条 → 合并后 {len(target['symptoms'])} 条")
    print(f"新增 {len(added)} 条：{added}")
    for item in conflicts:
        print(f"[冲突] {item}")

    if not args.check:
        target["version"] = "0.2.0-draft"
        TARGET.write_text(json.dumps(target, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"已写入 {TARGET}")
    else:
        print("（--check 模式，未写盘）")

    sys.path.insert(0, str(ROOT / "tools"))
    from validate_disease_library import validate  # noqa: E402

    errors, warnings, stats = validate()
    print(f"校验：病种 {stats.get('病种数')}，错误 {len(errors)} 项，警告 {len(warnings)} 项")
    for item in errors:
        print(f"  [ERROR] {item}")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
