"""疾病库校验器（CI 卡口 + 合并前自检）。

用法：
    python tools/validate_disease_library.py            # 校验并打印统计
    python tools/validate_disease_library.py --strict   # 有警告也返回非零退出码

检查项：
    1. JSON 合法性 / 顶层结构
    2. 必填字段完整性与取值域
    3. 症状 code 全部来自受控词表 symptoms.json
    4. 鉴别要点 vs_code 指向库内病种、features 合法、points 为负
    5. scale_links 指向真实量表；量表无条目时 item 必须为空
    6. 病种名称与别名全局唯一
    7. 术语红线：禁止「确诊概率 / 患病概率 / 诊断为」等表述
    8. 需求 §5.7 优先病种覆盖度
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys
from collections import Counter

ROOT = pathlib.Path(__file__).resolve().parents[1]
DISEASES_PATH = ROOT / "docs" / "structured" / "disease-library" / "diseases.json"
SYMPTOMS_PATH = ROOT / "docs" / "structured" / "disease-library" / "symptoms.json"
SCALES_DIR = ROOT / "docs" / "structured" / "assessment-scales"

VALID_RISK_LEVELS = {"immediate", "urgent", "elective", "observe"}
VALID_WEIGHTS = {"core", "secondary"}
VALID_URGENCY = {"立即就医", "尽快就医", "择期就诊", "居家观察"}
BANNED_TERMS = ["确诊概率", "患病概率", "诊断为", "确诊为", "一定是", "肯定是"]

# 需求 §5.7 优先覆盖的病种关键词
REQUIRED_KEYWORDS = [
    "心肌梗死", "脑卒中", "高血压", "心力衰竭", "肺炎", "阻塞性肺疾病",
    "骨折", "阿尔茨海默", "谵妄", "抑郁", "营养不良", "酮症酸中毒",
    "高渗高血糖", "低血糖", "糖尿病足", "尿路感染", "便秘", "肠梗阻",
    "误吸", "尿潴留", "贫血", "压力性损伤", "帕金森", "骨关节炎",
    "带状疱疹", "脓毒症",
]


def load_json(path: pathlib.Path):
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def collect_scale_items() -> dict[str, set[str]]:
    table: dict[str, set[str]] = {}
    if not SCALES_DIR.exists():
        return table
    for path in sorted(SCALES_DIR.glob("B.*.json")):
        try:
            payload = load_json(path)
        except Exception:
            continue
        codes = {
            question.get("code", "")
            for section in payload.get("sections", [])
            for question in section.get("questions", [])
        }
        table[payload.get("code", path.stem)] = {code for code in codes if code}
    return table


def validate() -> tuple[list[str], list[str], dict]:
    errors: list[str] = []
    warnings: list[str] = []

    try:
        data = load_json(DISEASES_PATH)
    except Exception as exc:
        return [f"疾病库 JSON 解析失败：{exc}"], [], {}

    try:
        symptom_table = {item["code"] for item in load_json(SYMPTOMS_PATH)["symptoms"]}
    except Exception as exc:
        return [f"症状词表读取失败：{exc}"], [], {}

    diseases = data.get("diseases")
    if not isinstance(diseases, list) or not diseases:
        return ["diseases 字段缺失或为空"], [], {}

    scale_items = collect_scale_items()
    codes = {item.get("code") for item in diseases}

    # 别名唯一性
    alias_owner: dict[str, str] = {}
    for disease in diseases:
        code = disease.get("code", "?")
        for alias in [disease.get("name", "")] + list(disease.get("aliases") or []):
            if not alias:
                continue
            if alias in alias_owner:
                errors.append(f"[{code}] 名称/别名「{alias}」与 {alias_owner[alias]} 重复")
            else:
                alias_owner[alias] = code

    for disease in diseases:
        code = disease.get("code", "?")

        for field in ("name", "system", "risk_level", "advice", "source", "review_note"):
            if not disease.get(field):
                errors.append(f"[{code}] 缺少字段 {field}")
        if disease.get("risk_level") not in VALID_RISK_LEVELS:
            errors.append(f"[{code}] risk_level 非法：{disease.get('risk_level')}")

        symptoms = disease.get("symptoms") or []
        if not symptoms:
            errors.append(f"[{code}] symptoms 为空")
        core = 0
        for symptom in symptoms:
            if symptom.get("code") not in symptom_table:
                errors.append(f"[{code}] 非法症状码 {symptom.get('code')}")
            if symptom.get("weight") not in VALID_WEIGHTS:
                errors.append(f"[{code}] symptom.weight 非法：{symptom.get('weight')}")
            if symptom.get("weight") == "core":
                core += 1
        if core == 0:
            errors.append(f"[{code}] 没有 core 症状")
        elif core > 5:
            warnings.append(f"[{code}] core 症状 {core} 条偏多，削弱区分度")

        if not disease.get("atypical_presentations"):
            errors.append(f"[{code}] 缺 atypical_presentations（老年人非典型表现）")
        if not disease.get("risk_factors"):
            errors.append(f"[{code}] 缺 risk_factors（高危因素）")

        for group, label in (("red_flags", "红旗征"), ("protective_signs", "保护性征象")):
            items = disease.get(group) or []
            if not items:
                warnings.append(f"[{code}] 缺 {label}（将退化为普通加权匹配）")
            for item in items:
                if item.get("code") not in symptom_table:
                    errors.append(f"[{code}] {label}非法 code：{item.get('code')}")
                if not item.get("term"):
                    errors.append(f"[{code}] {label}缺 term")
                if not item.get("note"):
                    warnings.append(f"[{code}] {label}「{item.get('term')}」缺 note")

        differentials = disease.get("differentials") or []
        if len(differentials) < 2:
            errors.append(f"[{code}] 鉴别要点不足 2 条（当前 {len(differentials)} 条）")
        for differential in differentials:
            vs = differential.get("vs_code")
            if vs not in codes:
                errors.append(f"[{code}] 鉴别 vs_code 不在库内：{vs}")
            if float(differential.get("points", 0)) >= 0:
                errors.append(f"[{code}] 鉴别 points 应为负：{differential.get('points')}")
            for feature in differential.get("features") or []:
                if feature not in symptom_table:
                    errors.append(f"[{code}] 鉴别 features 非法码：{feature}")
            if not differential.get("reason"):
                errors.append(f"[{code}] 鉴别缺 reason")

        for link in disease.get("scale_links") or []:
            scale = link.get("scale")
            item = link.get("item") or ""
            if scale not in scale_items:
                errors.append(f"[{code}] scale_links 指向不存在的量表：{scale}")
                continue
            known = scale_items[scale]
            if item and item not in known:
                errors.append(f"[{code}] scale_links 题目不存在：{scale} / {item}")
            if not known and item:
                errors.append(f"[{code}] 量表 {scale} 尚无条目，item 必须为空字符串")
            if not link.get("note"):
                warnings.append(f"[{code}] scale_links 缺 note：{scale}")

        advice = disease.get("advice") or {}
        if advice.get("urgency") not in VALID_URGENCY:
            errors.append(f"[{code}] advice.urgency 非法：{advice.get('urgency')}")
        if not advice.get("text"):
            errors.append(f"[{code}] advice.text 为空")
        if not advice.get("department"):
            warnings.append(f"[{code}] advice.department 为空")

        blob = json.dumps(disease, ensure_ascii=False)
        for term in BANNED_TERMS:
            if term in blob:
                errors.append(f"[{code}] 出现禁用表述「{term}」")

    # 覆盖度
    names = " ".join(item.get("name", "") for item in diseases)
    for keyword in REQUIRED_KEYWORDS:
        if keyword not in names:
            errors.append(f"[覆盖度] 缺少需求 §5.7 优先病种关键词「{keyword}」")

    stats = {
        "病种数": len(diseases),
        "症状引用数": sum(len(item.get("symptoms") or []) for item in diseases),
        "红旗征数": sum(len(item.get("red_flags") or []) for item in diseases),
        "保护征象数": sum(len(item.get("protective_signs") or []) for item in diseases),
        "鉴别条目数": sum(len(item.get("differentials") or []) for item in diseases),
        "高危因素数": sum(len(item.get("risk_factors") or []) for item in diseases),
        "非典型表现数": sum(len(item.get("atypical_presentations") or []) for item in diseases),
        "量表关联数": sum(len(item.get("scale_links") or []) for item in diseases),
        "风险分布": dict(Counter(item.get("risk_level") for item in diseases)),
        "系统分布": dict(Counter(item.get("system") for item in diseases)),
    }
    return errors, warnings, stats


def main() -> int:
    parser = argparse.ArgumentParser(description="校验老年易发疾病信息库")
    parser.add_argument("--strict", action="store_true", help="有警告时也返回非零退出码")
    args = parser.parse_args()

    errors, warnings, stats = validate()

    print("=" * 60)
    print("疾病库校验")
    print("=" * 60)
    for key, value in stats.items():
        print(f"  {key}: {value}")
    print("-" * 60)
    print(f"错误 {len(errors)} 项 / 警告 {len(warnings)} 项")
    for item in errors:
        print(f"  [ERROR] {item}")
    for item in warnings:
        print(f"  [WARN ] {item}")
    print("=" * 60)

    if errors:
        print("结论：不通过")
        return 1
    if warnings and args.strict:
        print("结论：严格模式不通过（仅警告）")
        return 1
    print("结论：通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
