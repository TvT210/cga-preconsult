"""模拟患者测试数据集自检。

校验六件事，任何一项不通过即退出码非 0：

1. **规模与分层**：100 名、5 个分层的配额符合设计；
2. **词表/病种锚定**：所有症状编码在词表内，28 个病种全覆盖且每种 ≥2 例；
3. **可抽取性（最关键）**：对话里被标注的症状，按后端
   `services/dialogue.py::extract_symptoms()` 的匹配规则
   （标准词 + 同义词 子串匹配）**必须能被抽出来**；
   标注 `expect_extraction=False` 的（方言/识别噪声）必须**抽不出来**——
   这正是「特殊交互」组要验证的行为：听不懂就追问，不要臆断。
4. **阴性症状确实被说出来**：匹配引擎要拿到排除信息才能给「缺失关键症状」证据；
5. **红线**：全文不得出现「确诊概率 / 患病概率 / 诊断为 / 建议停药」等；
   真值字段必须带「测试断言基准」声明。
6. **隐私**：全部标记 synthetic、手机号在保留测试号段、身份证已脱敏。

用法：
    python tools/check_simulated_patients.py
"""

from __future__ import annotations

import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "docs/structured/simulated-patients"
SYMPTOMS_PATH = ROOT / "docs/structured/disease-library/symptoms.json"
DISEASES_PATH = ROOT / "docs/structured/disease-library/diseases.json"

EXPECTED_COUNT = 100
EXPECTED_COHORTS = {"clear": 60, "vague": 15, "red_flag": 10, "comorbid": 10, "special": 5}
MIN_PER_DISEASE = 2

# 术语红线（与 AGENT.md「领域红线」一致）
FORBIDDEN_TERMS = [
    "确诊概率",
    "患病概率",
    "诊断为",
    "确诊为",
    "建议停药",
    "建议加药",
    "调整剂量",
    "剂量调整为",
]


def as_list(payload, key):
    if isinstance(payload, dict) and key in payload:
        return payload[key]
    return payload if isinstance(payload, list) else []


def load_symptom_index() -> list[tuple[str, str]]:
    """与后端 `_symptom_index()` 保持一致：标准词 + 同义词，按长度降序。"""
    table = as_list(json.loads(SYMPTOMS_PATH.read_text(encoding="utf-8")), "symptoms")
    index: list[tuple[str, str]] = []
    for item in table:
        index.append((item.get("term", item["code"]), item["code"]))
        for synonym in item.get("synonyms", []) or []:
            index.append((synonym, item["code"]))
    index.sort(key=lambda pair: len(pair[0]), reverse=True)
    return index


def extract_codes(text: str, index: list[tuple[str, str]]) -> set[str]:
    """复刻后端 `extract_symptoms()` 的子串匹配。"""
    lowered = (text or "").lower()
    return {code for term, code in index if term and term.lower() in lowered}


def main() -> int:
    failures: list[str] = []
    warnings: list[str] = []

    patients_doc = json.loads((DATA_DIR / "patients.json").read_text(encoding="utf-8"))
    patients = patients_doc["patients"]
    dialogues = [
        json.loads(line)
        for line in (DATA_DIR / "dialogues.jsonl").read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    scale_answers = json.loads((DATA_DIR / "scale_answers.json").read_text(encoding="utf-8"))["answers"]
    diseases = as_list(json.loads(DISEASES_PATH.read_text(encoding="utf-8")), "diseases")
    symptom_codes = {s["code"] for s in as_list(json.loads(SYMPTOMS_PATH.read_text(encoding="utf-8")), "symptoms")}
    index = load_symptom_index()

    # ---- 1. 规模与分层 ----
    if len(patients) != EXPECTED_COUNT:
        failures.append(f"患者数应为 {EXPECTED_COUNT}，实际 {len(patients)}")
    if len(dialogues) != len(patients):
        failures.append(f"对话数({len(dialogues)})与患者数({len(patients)})不一致")
    if len(scale_answers) != len(patients):
        failures.append(f"量表作答组数({len(scale_answers)})与患者数不一致")

    cohort_counter: dict[str, int] = {}
    for patient in patients:
        cohort_counter[patient["cohort"]] = cohort_counter.get(patient["cohort"], 0) + 1
    if cohort_counter != EXPECTED_COHORTS:
        failures.append(f"分层配额不符：期望 {EXPECTED_COHORTS}，实际 {cohort_counter}")

    # ---- 2. 词表 / 病种锚定 ----
    disease_counter: dict[str, int] = {}
    for patient in patients:
        primary = patient["expected_disease"]["primary"]
        disease_counter[primary["code"]] = disease_counter.get(primary["code"], 0) + 1
        for item in patient["disease_presentation"]["symptoms"]:
            if item["symptom_code"] not in symptom_codes:
                failures.append(f"{patient['patient_id']} 症状编码不在词表：{item['symptom_code']}")
        for item in patient["disease_presentation"]["negative_symptoms"]:
            if item["symptom_code"] not in symptom_codes:
                failures.append(f"{patient['patient_id']} 阴性症状编码不在词表：{item['symptom_code']}")
        if patient["expected_disease"]["primary"]["risk_level"] not in {"immediate", "urgent", "elective"}:
            failures.append(f"{patient['patient_id']} 风险等级非法：{patient['expected_disease']['primary']['risk_level']}")
    for disease in diseases:
        code = disease["code"]
        if disease_counter.get(code, 0) < MIN_PER_DISEASE:
            failures.append(f"病种 {code}（{disease['name']}）仅 {disease_counter.get(code, 0)} 例，少于 {MIN_PER_DISEASE}")

    # ---- 3. 可抽取性（逐句粒度）----
    # 判定粒度是**单句**：一句被标注为「能抽出」就必须能被抽出；
    # 一句被标注为「抽不中」（方言/识别噪声）就必须抽不出来——
    # 这正是「特殊交互」组要验证的行为：听不懂就追问，不要臆断。
    dialogue_by_id = {d["patient_id"]: d for d in dialogues}
    expect_miss = 0
    for patient in patients:
        dialogue = dialogue_by_id.get(patient["patient_id"])
        if dialogue is None:
            failures.append(f"{patient['patient_id']} 缺少对话")
            continue
        patient_text = "\n".join(
            turn["text"] for turn in dialogue["turns"] if turn["role"] == "patient"
        )
        extracted = extract_codes(patient_text, index)

        for turn in dialogue["turns"]:
            code = turn.get("symptom_code")
            if not code:
                continue
            turn_codes = extract_codes(turn["text"], index)
            hit = code in turn_codes
            if turn.get("expect_extraction", True):
                if not hit:
                    failures.append(
                        f"{patient['patient_id']} 第 {turn['seq']} 轮标注的症状 {code} "
                        f"在本句中抽不出来（文本：{turn['text'][:30]}）"
                    )
            else:
                expect_miss += 1
                if hit:
                    failures.append(
                        f"{patient['patient_id']} 第 {turn['seq']} 轮标注为「抽不中」但本句命中 {code}"
                        f"（文本：{turn['text'][:30]}）"
                    )

        # ---- 4. 阴性症状确实说出来了 ----
        for negative in patient["disease_presentation"]["negative_symptoms"][:3]:
            if negative["symptom_code"] not in extracted:
                failures.append(
                    f"{patient['patient_id']} 阴性症状 {negative['symptom_code']} 没出现在对话里，"
                    f"匹配引擎拿不到排除信息"
                )

    # ---- 5. 红线 ----
    all_text = json.dumps(patients, ensure_ascii=False) + "\n" + "\n".join(
        json.dumps(d, ensure_ascii=False) for d in dialogues
    )
    for term in FORBIDDEN_TERMS:
        if term in all_text:
            failures.append(f"出现红线术语：{term}")
    for patient in patients:
        note = patient["expected_disease"].get("note", "")
        if "测试断言基准" not in note:
            failures.append(f"{patient['patient_id']} 真值字段缺少「测试断言基准」声明")

    # ---- 6. 隐私 ----
    for patient in patients:
        if not patient.get("synthetic"):
            failures.append(f"{patient['patient_id']} 未标记 synthetic")
        phone = patient["basic_info"].get("phone", "")
        if not re.fullmatch(r"1380000\d{4}", phone):
            failures.append(f"{patient['patient_id']} 手机号不在保留测试号段：{phone}")
        if "*" not in patient["basic_info"].get("id_card_masked", ""):
            failures.append(f"{patient['patient_id']} 身份证未脱敏")

    # ---- 输出 ----
    print("=" * 68)
    print("模拟患者测试数据集自检")
    print("=" * 68)
    print(f"患者 {len(patients)} 名｜对话 {len(dialogues)} 组｜量表作答 {len(scale_answers)} 组")
    print(f"分层：{cohort_counter}")
    print(f"病种覆盖：{len(disease_counter)}/{len(diseases)}（单病种最少 {min(disease_counter.values()) if disease_counter else 0} 例）")
    print(f"对话总轮次：{sum(d['turn_count'] for d in dialogues)}")
    print(f"故意抽不中的样本：{expect_miss} 处（用于验证「听不懂就追问」）")
    print("-" * 68)
    if warnings:
        for item in warnings:
            print(f"[提醒] {item}")
    if failures:
        for item in failures:
            print(f"[不通过] {item}")
        print("-" * 68)
        print(f"结论：不通过（{len(failures)} 项）")
        return 1
    print("全部通过")
    print("=" * 68)
    return 0


if __name__ == "__main__":
    sys.exit(main())
