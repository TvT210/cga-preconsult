"""题库完整性与判读边界测试（线 A / 采集与判读）。

覆盖三件事：
1. 21 张量表题库是否可采集、可计分（G1 的验收口径）；
2. 标准给了分界值的量表，边界值判读是否与 WS/T 888—2026 附录 B 一致；
3. 引擎扩展（条目 when、criteria、single_option_level、实测分档校验）是否按设计工作。
"""

from __future__ import annotations

import glob
import json
import pathlib
import re

import pytest

from app.services.scales_store import SCALES_DIR, load_symptoms
from app.services.scoring import AnswerRecord, evaluate_scale

SCALE_CODES = [f"B.{i}" for i in range(1, 22)]


def _load(code: str) -> dict:
    path = SCALES_DIR / f"{code}.json"
    assert path.exists(), f"缺少题库文件 {code}.json"
    return json.loads(path.read_text(encoding="utf-8"))


def _questions(scale: dict) -> list[dict]:
    return [q for s in scale.get("sections", []) for q in s.get("questions", [])]


def _answers(scale: dict, picks: dict[str, str], measured: dict[str, float] | None = None) -> dict[str, AnswerRecord]:
    """按 {题号: 选项 value} 构造作答记录，分值取自题库选项（不手写分值）。"""
    table: dict[str, AnswerRecord] = {}
    measured = measured or {}
    for question in _questions(scale):
        code = question["code"]
        if code not in picks:
            continue
        value = picks[code]
        options = question.get("options", [])
        if isinstance(value, list):
            chosen = [opt for opt in options if opt.get("value") in value]
            score = sum(float(opt.get("score") or 0) for opt in chosen)
            stored = ",".join(str(opt.get("value")) for opt in chosen)
        else:
            option = next((opt for opt in options if str(opt.get("value")) == str(value)), None)
            score = float(option.get("score") or 0) if option else None
            stored = str(value)
        table[code] = AnswerRecord(value=stored, score=score, measured=measured.get(code))
    return table


def _all_picks(scale: dict, index: int = 0) -> dict[str, str]:
    """取每题的第 index 个选项（0 = 第一项，-1 = 最后一项），用于跑通型用例。"""
    picks = {}
    for question in _questions(scale):
        options = question.get("options") or []
        if options:
            picks[question["code"]] = options[index]["value"]
    return picks


# ---------------------------------------------------------------- 1. 题库完整性


@pytest.mark.parametrize("code", SCALE_CODES)
def test_scale_bank_is_collectable(code):
    scale = _load(code)
    assert scale["code"] == code
    assert scale["standard_ref"].startswith("WS/T 888—2026 附录B"), "必须标注标准条文出处"
    questions = _questions(scale)
    assert questions, f"{code} 题库为空，无法采集"

    items = scale["scoring"]["score"]["config"]["items"]
    assert items, f"{code} 缺少计分条目"
    codes = {q["code"] for q in questions}
    for item in items:
        assert item["code"] in codes, f"{code} 计分条目 {item['code']} 没有对应题目"

    for question in questions:
        assert question.get("text"), f"{code} 题目缺 text"
        assert question.get("plain_text"), f"{code} 题目缺适老化口语 plain_text"
        if question.get("input_type") in {"single", "multi"}:
            assert question.get("options"), f"{code}/{question['code']} 缺选项"
            for option in question["options"]:
                assert option.get("label") and "score" in option, f"{code}/{question['code']} 选项缺 label 或 score"


@pytest.mark.parametrize("code", SCALE_CODES)
def test_scale_scores_end_to_end(code):
    """满分路径与零分路径都能出结论，不抛异常。"""
    scale = _load(code)
    for index in (0, -1):
        picks = _all_picks(scale, index)
        result = evaluate_scale(scale, _answers(scale, picks))
        assert result.level, f"{code} 未产出判读等级"
        assert isinstance(result.total, (int, float))
        assert result.rule_refs, f"{code} 缺少可回溯的规则引用"


def test_total_question_count_and_all_review_draft():
    total = sum(len(_questions(_load(code))) for code in SCALE_CODES)
    assert total >= 110, f"21 张量表题目总数偏少：{total}"
    for code in SCALE_CODES:
        assert _load(code)["review_status"] == "draft_pending_medical_review"


@pytest.mark.parametrize("code", SCALE_CODES)
def test_flag_symptom_codes_hit_vocabulary(code):
    """阳性标记的症状编码必须命中症状词表，否则 B 线匹配引擎召回不到。"""
    vocabulary = set(load_symptoms())
    scale = _load(code)
    for flag in scale["scoring"].get("flags") or []:
        for symptom in flag.get("symptom_codes", []):
            assert symptom in vocabulary, f"{code} 的症状编码 {symptom} 不在词表中"


def test_no_forbidden_terms_in_scale_text():
    """红线 4：对外文案不得出现诊断式概率表述，也不得给用药建议。"""
    forbidden = ["确诊概率", "患病概率", "确诊为", "停药", "减药", "加药", "自行服用"]
    for code in SCALE_CODES:
        scale = _load(code)
        texts = [scale.get("summary", "")]
        for question in _questions(scale):
            texts.append(question.get("text", ""))
            texts.append(question.get("plain_text", ""))
            texts.extend(opt.get("label", "") for opt in question.get("options", []))
        for level in (scale["scoring"].get("levels", {}).get("config", {}) or {}).get("levels", []):
            texts.extend([level.get("level", ""), level.get("interpretation", "")])
        for rule in (scale["scoring"].get("levels", {}).get("config", {}) or {}).get("rules", []):
            texts.extend([rule.get("level", ""), rule.get("interpretation", "")])
        for flag in scale["scoring"].get("flags") or []:
            texts.append(flag.get("flag", ""))
        blob = " ".join(texts)
        for word in forbidden:
            assert word not in blob, f"{code} 文案出现禁用表述：{word}"


# ---------------------------------------------------------------- 2. 标准边界值


def test_b3_sppb_boundaries():
    scale = _load("B.3")

    def run(balance_c, gait, chair):
        picks = {
            "B3-01": "hold", "B3-02": "hold",
            "B3-03": balance_c, "B3-04": gait, "B3-05": chair,
        }
        return evaluate_scale(scale, _answers(scale, picks))

    assert run("hold", "lt_4_82", "lte_11_19").total == 12
    assert run("hold", "lt_4_82", "lte_11_19").level == "良好"
    # 平衡 4（1+1+2）+ 步速 3 + 起坐 2 = 9 → 中等
    assert run("hold", "4_82_6_20", "13_70_16_69").total == 9
    assert run("hold", "4_82_6_20", "13_70_16_69").level == "中等"
    # 平衡 4 + 步速 3 + 起坐 0 = 7 → 中等（下边界）
    assert run("hold", "4_82_6_20", "unable").total == 7
    assert run("hold", "4_82_6_20", "unable").level == "中等"
    # 平衡 4 + 步速 2 + 起坐 0 = 6 → 较差（上边界）
    assert run("hold", "6_21_8_70", "unable").total == 6
    assert run("hold", "6_21_8_70", "unable").level == "较差"
    # 平衡三项全部未保持 + 步速与起坐均不能完成 → 0 分
    zero = evaluate_scale(scale, _answers(scale, {
        "B3-01": "fail", "B3-02": "fail", "B3-03": "fail", "B3-04": "unable", "B3-05": "unable"}))
    assert zero.total == 0
    assert zero.level == "较差"
    assert zero.severity == "high"


def test_b3_speed_band_is_score_not_seconds():
    """实测项的关键回归：4.5 秒应落到 <4.82 s 档得 4 分，而不是 4.5 分。"""
    scale = _load("B.3")
    picks = {"B3-01": "hold", "B3-02": "hold", "B3-03": "hold", "B3-04": "lt_4_82", "B3-05": "lte_11_19"}
    result = evaluate_scale(scale, _answers(scale, picks, measured={"B3-04": 4.5}))
    assert result.total == 12
    assert not [n for n in result.notices if "不一致" in n], "4.5 s 落在 <4.82 s 区间，不应报警"


def test_b3_measured_band_mismatch_requires_review():
    """秒数与所选分档不一致时，不能静默采信。"""
    scale = _load("B.3")
    picks = {"B3-01": "hold", "B3-02": "hold", "B3-03": "hold", "B3-04": "gt_8_70", "B3-05": "lte_11_19"}
    result = evaluate_scale(scale, _answers(scale, picks, measured={"B3-04": 4.5}))
    assert result.needs_manual_review is True
    assert any("不一致" in notice for notice in result.notices)


@pytest.mark.parametrize(
    "code,question,value,expected_level",
    [
        ("B.4", "B4-01", "4", "视力正常"),
        ("B.4", "B4-01", "3", "低视力"),
        ("B.4", "B4-01", "2", "盲"),
        ("B.4", "B4-01", "1", "盲"),
        ("B.4", "B4-01", "0", "完全失明"),
        ("B.6", "B6-01", "4", "听力正常"),
        ("B.6", "B6-01", "3", "听力下降"),
        ("B.6", "B6-01", "2", "听力障碍"),
        ("B.6", "B6-01", "0", "完全失聪"),
        ("B.17", "B17-01", "l1_within5", "1 级（正常）"),
        ("B.17", "B17-01", "l1_over5", "1 级（可疑异常）"),
        ("B.17", "B17-01", "l2", "2 级（可疑异常）"),
        ("B.17", "B17-01", "l5", "5 级（异常）"),
    ],
)
def test_single_item_boundaries(code, question, value, expected_level):
    scale = _load(code)
    result = evaluate_scale(scale, _answers(scale, {question: value}))
    assert result.level == expected_level


def test_b5_visual_function_scoring_direction():
    """B.5 是 0 分=是、1 分=否，答「是」越多分越低。"""
    scale = _load("B.5")
    good = evaluate_scale(scale, _answers(scale, {"B5-01": "no", "B5-02": "no", "B5-03": "no"}))
    assert good.total == 3 and good.level == "视功能良好"
    one = evaluate_scale(scale, _answers(scale, {"B5-01": "yes", "B5-02": "no", "B5-03": "no"}))
    assert one.total == 2 and one.level == "视功能较差"
    worst = evaluate_scale(scale, _answers(scale, {"B5-01": "yes", "B5-02": "yes", "B5-03": "yes"}))
    assert worst.total == 0 and worst.level == "视功能差"


def test_b7_whisper_any_side_positive():
    scale = _load("B.7")
    negative = evaluate_scale(scale, _answers(scale, {"B7-01": "pass", "B7-02": "pass"}))
    assert negative.level == "阴性" and negative.abnormal is False
    one_side = evaluate_scale(scale, _answers(scale, {"B7-01": "fail", "B7-02": "pass"}))
    assert one_side.level == "阳性" and one_side.total == 1


@pytest.mark.parametrize(
    "clock,recall,total,level",
    [("correct", "3", 5, "筛查阴性"), ("correct", "1", 3, "筛查阴性"),
     ("wrong", "2", 2, "筛查阳性"), ("wrong", "0", 0, "筛查阳性")],
)
def test_b8_mini_cog_boundaries(clock, recall, total, level):
    scale = _load("B.8")
    picks = {"B8-01": "3", "B8-02": clock, "B8-03": recall}
    result = evaluate_scale(scale, _answers(scale, picks))
    assert result.total == total
    assert result.level == level


def test_b9_home_environment_has_no_invented_cutoff():
    """标准只给方向不给分界：本表不得凭空分级。"""
    scale = _load("B.9")
    levels = scale["scoring"]["levels"]["config"]["levels"]
    assert len(levels) == 1, "标准未给分界值，不应人为拆分等级"
    low = evaluate_scale(scale, _answers(scale, {f"B9-{i:02d}": "no" for i in range(1, 15)}))
    high = evaluate_scale(scale, _answers(scale, {f"B9-{i:02d}": "yes" for i in range(1, 15)}))
    assert low.total == 0 and high.total == 14
    assert low.level == high.level == "已完成居家环境筛查"
    assert [f["flag"] for f in low.flags], "低分场景应给出条目级风险提示"


def test_b11_icqsf_range_and_types():
    scale = _load("B.11")
    none = evaluate_scale(scale, _answers(scale, {"B11-01": "0", "B11-02": "0", "B11-03": "0"}))
    assert none.total == 0 and none.level == "无漏尿"
    worst = evaluate_scale(scale, _answers(scale, {"B11-01": "5", "B11-02": "6", "B11-03": "10"}))
    assert worst.total == 21 and worst.level == "存在尿失禁"
    assert worst.severity == "medium"


def test_b12_requires_manual_judgement():
    scale = _load("B.12")
    assert scale.get("review_required") is True
    picks = {"B12-03": ["fewer_than_3", "manual"]}
    result = evaluate_scale(scale, _answers(scale, picks))
    assert result.total == 2, "应统计命中的症状条目数"
    assert result.level == "待医务人员判断"
    assert result.needs_manual_review is True
    assert any("由医务人员判断" in notice for notice in result.notices)


def test_b15_ventilation_path_only_counts_three_items():
    """插管走条目 1+2+3，非插管走 1+2+4，两种情况都只能是三项之和。"""
    scale = _load("B.15")
    vent = evaluate_scale(scale, _answers(scale, {
        "B15-00": "vent", "B15-01": "4", "B15-02": "4", "B15-03": "4", "B15-04": "1"}))
    assert vent.total == 12, "插管时不应把发声条目计入"
    non_vent = evaluate_scale(scale, _answers(scale, {
        "B15-00": "non_vent", "B15-01": "1", "B15-02": "1", "B15-03": "4", "B15-04": "1"}))
    assert non_vent.total == 3, "非插管时不应把机械通气条目计入"
    min_case = evaluate_scale(scale, _answers(scale, {
        "B15-00": "non_vent", "B15-01": "1", "B15-02": "1", "B15-04": "1"}))
    assert min_case.total == 3 and min_case.level == "疼痛行为评分"


@pytest.mark.parametrize(
    "answers,expected_level,severity",
    [
        # 表现型 + 病因型 + 重度指标 → 重度
        ({"B20-01": "yes", "B20-09": "yes", "B20-11": "yes"}, "营养不良（重度）", "high"),
        # 表现型 + 病因型，未达重度 → 中度
        ({"B20-04": "yes", "B20-06": "yes"}, "营养不良（中度）", "medium"),
        # 只有表现型 → 未达诊断标准
        ({"B20-05": "yes"}, "未达营养不良诊断标准（存在单项指标异常）", "info"),
        # 全阴性
        ({"B20-01": "no", "B20-09": "no"}, "未达营养不良诊断标准", "none"),
    ],
)
def test_b20_glim_criteria(answers, expected_level, severity):
    scale = _load("B.20")
    picks = {f"B20-{i:02d}": "no" for i in range(1, 15)}
    picks.update(answers)
    result = evaluate_scale(scale, _answers(scale, picks))
    assert result.level == expected_level
    assert result.severity == severity


@pytest.mark.parametrize(
    "answers,expected_level",
    [
        # 条目1（问题1）+ 条目2 + 条目3 → 阳性
        ({"B21-01": "yes", "B21-03": "yes", "B21-04": "yes"}, "谵妄评估阳性"),
        # 条目1（问题2）+ 条目2 + 条目4 → 阳性
        ({"B21-02": "yes", "B21-03": "yes", "B21-05": "yes"}, "谵妄评估阳性"),
        # 只有条目 3、4，缺条目 1、2 → 阴性
        ({"B21-04": "yes", "B21-05": "yes"}, "谵妄评估阴性"),
        # 条目 1+2 阳性但 3、4 均阴性 → 阴性
        ({"B21-01": "yes", "B21-03": "yes"}, "谵妄评估阴性"),
    ],
)
def test_b21_cam_boolean_logic(answers, expected_level):
    scale = _load("B.21")
    picks = {f"B21-{i:02d}": "no" for i in range(1, 6)}
    picks.update(answers)
    result = evaluate_scale(scale, _answers(scale, picks))
    assert result.level == expected_level
    if expected_level == "谵妄评估阳性":
        assert result.needs_manual_review is True, "阳性结论必须交医师确认"
        assert "诊断结论" in result.interpretation or "不作为诊断" in result.interpretation


# ---------------------------------------------------------------- 3. 引擎通用行为


def test_thresholds_come_from_bank_not_code():
    """改题库阈值即改结论，证明判读阈值没有被硬编码进代码。"""
    scale = _load("B.4")
    picks = {"B4-01": "3"}
    assert evaluate_scale(scale, _answers(scale, picks)).level == "低视力"
    patched = json.loads(json.dumps(scale))
    for level in patched["scoring"]["levels"]["config"]["levels"]:
        if level["level"] == "低视力":
            level["level"] = "视力下降（演示改配）"
    assert evaluate_scale(patched, _answers(patched, picks)).level == "视力下降（演示改配）"


def test_missing_items_flag_manual_review():
    scale = _load("B.3")
    result = evaluate_scale(scale, _answers(scale, {"B3-01": "hold"}))
    assert result.missing_items
    assert result.needs_manual_review is True
    assert any("缺项" in notice for notice in result.notices)


def test_draft_bank_never_claims_clinical_conclusion():
    for code in SCALE_CODES:
        scale = _load(code)
        result = evaluate_scale(scale, _answers(scale, _all_picks(scale)))
        assert result.needs_manual_review is True
        assert any("评审" in notice for notice in result.notices)


def test_rule_refs_traceable_to_answers():
    scale = _load("B.11")
    picks = {"B11-01": "3", "B11-02": "4", "B11-03": "5"}
    result = evaluate_scale(scale, _answers(scale, picks))
    score_ref = next(ref for ref in result.rule_refs if ref["rule"].startswith("score:"))
    traced = {item["question"]: item["value"] for item in score_ref["items"]}
    assert traced["B11-01"] == "3"
    assert score_ref["answered_count"] == 3
    assert any(ref["rule"] == "levels:level_map" for ref in result.rule_refs)


# ------------------------------------------------ 4. 原文符合性（A-1 核对补充）


@pytest.mark.parametrize("code", SCALE_CODES)
def test_level_map_ranges_never_overlap(code):
    """分级区间必须互不重叠。

    按 level_map 顺序匹配时，重叠会让后一档永远落空。
    B.13 曾出现「4～6」与「≥6」在 6 分处重叠，6 分被错判为「可能存在」。
    """
    levels_spec = _load(code)["scoring"].get("levels") or {}
    if levels_spec.get("rule_type") != "level_map":
        return
    spans = sorted(
        (int(item["min"]), int(item["max"]), item.get("level", ""))
        for item in (levels_spec.get("config") or {}).get("levels", [])
    )
    for low, high, name in spans:
        assert low <= high, f"{code} 区间 {low}~{high}（{name}）上下界颠倒"
    for (a_low, a_high, a_name), (b_low, b_high, b_name) in zip(spans, spans[1:]):
        assert a_high < b_low, (
            f"{code} 区间 {a_low}~{a_high}（{a_name}）与 {b_low}~{b_high}（{b_name}）重叠"
        )


def test_b2_partial_help_still_scores_one():
    """表B.2 原文：第 2、4、5、6、8 项「需部分协助」仍记 1 分，不能按「能否独立」二分。"""
    scale = _load("B.2")
    questions = {item["code"]: item for item in _questions(scale)}

    assert [o["score"] for o in questions["B2-02"]["options"]] == [1, 1, 1, 0, 0]
    assert [o["score"] for o in questions["B2-04"]["options"]] == [1, 1, 1, 1, 0]
    assert [o["score"] for o in questions["B2-05"]["options"]] == [1, 1, 0]
    assert [o["score"] for o in questions["B2-06"]["options"]] == [1, 1, 1, 0]
    assert [o["score"] for o in questions["B2-08"]["options"]] == [1, 1, 0]

    # 五项「需部分协助」档位各得 1 分，合计 5 分 → 中度依赖（旧实现会全判 0 分）
    picks = {
        "B2-01": "3",
        "B2-02": "3",
        "B2-03": "3",
        "B2-04": "4",
        "B2-05": "2",
        "B2-06": "2",
        "B2-07": "2",
        "B2-08": "2",
    }
    result = evaluate_scale(scale, _answers(scale, picks))
    assert result.total == 5
    assert result.level == "中度受损"


def test_b18_three_part_scoring_includes_age_bonus():
    """表B.18-2：营养状态受损 + 疾病严重 + 年龄≥70 加 1 分，满分 7 分。"""
    scale = _load("B.18")
    picks = {"B18-S1": "yes", "B18-T1": "2", "B18-T2": "0", "B18-T3": "ge70"}
    result = evaluate_scale(scale, _answers(scale, picks))
    assert result.total == 3
    assert result.level == "存在营养风险"

    # 同为营养 2 分，70 岁以下不加分 → 2 分，未达风险阈值
    young = evaluate_scale(scale, _answers(scale, {"B18-S1": "yes", "B18-T1": "2", "B18-T2": "0", "B18-T3": "lt70"}))
    assert young.total == 2
    assert young.level == "未达营养风险"


def test_b18_screening_gate_skips_final_section():
    """初筛全为「否」时终筛不出现，按标准应每周复评，不进入计分。"""
    scale = _load("B.18")
    picks = {"B18-S1": "no", "B18-S2": "no", "B18-S3": "no", "B18-S4": "no", "B18-T1": "3"}
    result = evaluate_scale(scale, _answers(scale, picks))
    assert result.total == 0
    assert result.level == "未达营养风险"


def test_b13_overlap_removed_without_changing_ruling():
    """表B.13 注2「4～6」与「≥6」在 6 分处重叠。

    本表保留既有判读口径（6 分归「可能存在」，7 分及以上归「存在」），
    但把区间写成互不重叠的 4～6 与 7～24，避免 level_map 首个命中造成隐性吞档。
    """
    scale = _load("B.13")
    six = evaluate_scale(scale, _answers(scale, {"B13-01": "3", "B13-02": "3"}))
    assert six.total == 6
    assert six.level == "可能存在睡眠障碍"

    seven = evaluate_scale(scale, _answers(scale, {"B13-01": "3", "B13-02": "3", "B13-03": "1"}))
    assert seven.total == 7
    assert seven.level == "存在睡眠障碍"
