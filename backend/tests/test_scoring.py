"""计分与判读引擎单元测试。"""

from __future__ import annotations

import json
import pathlib

import pytest

from app.services.scoring import AnswerRecord, evaluate_scale, branch_recommendations

EXAMPLE = pathlib.Path(__file__).resolve().parents[2] / "docs" / "structured" / "assessment-scales" / "_scale.example.json"


@pytest.fixture()
def scale() -> dict:
    return json.loads(EXAMPLE.read_text(encoding="utf-8"))


def _answers(scale: dict, picks: dict[str, str]) -> dict[str, AnswerRecord]:
    table = {}
    for section in scale["sections"]:
        for question in section["questions"]:
            code = question["code"]
            if code not in picks:
                continue
            value = picks[code]
            option = next((opt for opt in question.get("options", []) if opt["value"] == value), None)
            table[code] = AnswerRecord(value=value, score=float(option["score"]) if option else None)
    return table


def test_full_score_is_no_dependency(scale):
    picks = {q["code"]: q["options"][0]["value"] for s in scale["sections"] for q in s["questions"]}
    result = evaluate_scale(scale, _answers(scale, picks))
    assert result.total == 100
    assert result.level == "无依赖"
    assert result.abnormal is False
    assert result.needs_manual_review is True  # 题库仍为待评审草稿


def test_severe_dependency_level(scale):
    picks = {q["code"]: q["options"][-1]["value"] for s in scale["sections"] for q in s["questions"]}
    result = evaluate_scale(scale, _answers(scale, picks))
    assert result.total == 0
    assert result.level == "重度依赖"
    assert result.abnormal is True
    assert result.severity == "high"


def test_missing_items_require_manual_review(scale):
    picks = {"B1-01": "10", "B1-02": "5"}
    result = evaluate_scale(scale, _answers(scale, picks))
    assert result.missing_items
    assert result.needs_manual_review is True
    assert any("缺项" in notice for notice in result.notices)


def test_rule_refs_are_traceable(scale):
    picks = {"B1-01": "5"}
    result = evaluate_scale(scale, _answers(scale, picks))
    score_rule = next(item for item in result.rule_refs if item["rule"] == "score:sum")
    detail = next(item for item in score_rule["items"] if item["question"] == "B1-01")
    assert detail["value"] == "5"
    assert detail["score"] == 5
    assert detail["max_score"] == 10


def test_flags_map_to_symptoms(scale):
    picks = {q["code"]: q["options"][0]["value"] for s in scale["sections"] for q in s["questions"]}
    picks["B1-09"] = "5"  # 平地行走需极大帮助
    result = evaluate_scale(scale, _answers(scale, picks))
    assert any(flag["flag"] == "行走能力受限" for flag in result.flags)
    flag = next(f for f in result.flags if f["flag"] == "行走能力受限")
    assert "difficulty_walking" in flag["symptom_codes"]


def test_branch_recommendation(scale):
    picks = {q["code"]: q["options"][0]["value"] for s in scale["sections"] for q in s["questions"]}
    picks["B1-09"] = "5"
    branches = branch_recommendations(scale, _answers(scale, picks))
    assert any(item["target_scale"] == "B.3" for item in branches)


def test_count_positive_rule():
    scale = {
        "code": "T1",
        "review_status": "approved",
        "sections": [
            {
                "code": "S1",
                "questions": [
                    {
                        "code": "Q1",
                        "text": "题",
                        "input_type": "single",
                        "options": [{"value": "1", "label": "是", "score": 1}, {"value": "0", "label": "否", "score": 0}],
                    },
                    {
                        "code": "Q2",
                        "text": "题2",
                        "input_type": "single",
                        "options": [{"value": "1", "label": "是", "score": 1}, {"value": "0", "label": "否", "score": 0}],
                    },
                ],
            }
        ],
        "scoring": {
            "score": {"rule_type": "count_positive", "config": {"mode": "score_positive", "items": [{"code": "Q1"}, {"code": "Q2"}]}},
            "levels": {
                "rule_type": "level_map",
                "config": {
                    "levels": [
                        {"min": 0, "max": 0, "level": "无", "interpretation": "无阳性", "abnormal": False, "severity": "none"},
                        {"min": 1, "max": 2, "level": "阳性", "interpretation": "存在阳性条目", "abnormal": True, "severity": "medium"},
                    ]
                },
            },
        },
    }
    answers = {"Q1": AnswerRecord(value="1", score=1.0), "Q2": AnswerRecord(value="0", score=0.0)}
    result = evaluate_scale(scale, answers)
    assert result.total == 1
    assert result.level == "阳性"
    assert result.needs_manual_review is False
