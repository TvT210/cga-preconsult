"""症状—疾病匹配引擎单元测试。"""

from __future__ import annotations

from app.services.matching import MatchingWeights, build_evidence, run_matching

DISEASES = [
    {
        "code": "D1",
        "name": "疾病甲",
        "aliases": ["甲病"],
        "system": "系统一",
        "risk_level": "immediate",
        "review_status": "draft_pending_medical_review",
        "payload": {
            "risk_level": "immediate",
            "symptoms": [
                {"code": "chest_pain", "weight": "core"},
                {"code": "dyspnea", "weight": "core"},
                {"code": "palpitations", "weight": "secondary"},
            ],
            "differentials": [{"vs_code": "D2", "features": ["fever"], "points": -10, "reason": "无发热线索时更倾向疾病乙"}],
            "advice": {"department": "内科", "urgency": "立即就医", "text": "请尽快就医。"},
        },
    },
    {
        "code": "D2",
        "name": "疾病乙",
        "aliases": [],
        "system": "系统二",
        "risk_level": "elective",
        "review_status": "draft_pending_medical_review",
        "payload": {
            "risk_level": "elective",
            "symptoms": [{"code": "fever", "weight": "core"}, {"code": "cough", "weight": "core"}],
            "differentials": [],
            "advice": {"department": "呼吸科", "urgency": "择期就诊", "text": "建议门诊就诊。"},
        },
    },
    {
        "code": "D3",
        "name": "疾病丙",
        "aliases": [],
        "system": "系统三",
        "risk_level": "observe",
        "review_status": "draft_pending_medical_review",
        "payload": {"risk_level": "observe", "symptoms": [{"code": "constipation", "weight": "core"}], "differentials": [], "advice": {}},
    },
    {
        "code": "D4",
        "name": "疾病丁",
        "aliases": [],
        "system": "系统四",
        "risk_level": "elective",
        "review_status": "draft_pending_medical_review",
        "payload": {"risk_level": "elective", "symptoms": [{"code": "joint_pain", "weight": "core"}], "differentials": [], "advice": {}},
    },
]

WEIGHTS = MatchingWeights(core=3.0, secondary=1.0, history_bonus=15.0, temperature=10.0, global_threshold=60.0)


def _run(codes, conditions=None):
    evidence = build_evidence([], [{"code": code} for code in codes], conditions or [])
    return run_matching(DISEASES, evidence, WEIGHTS, {"global": 60.0})


def test_evidence_from_scale_and_dialogue():
    evidence = build_evidence(
        [{"code": "x", "symptom_codes": ["chest_pain"]}],
        [{"code": "dyspnea"}],
        ["高血压"],
    )
    assert "chest_pain" in evidence["symptom_codes"]
    assert "dyspnea" in evidence["symptom_codes"]
    assert "高血压" in evidence["conditions"]


def test_top_candidates_include_three():
    outcome = _run(["chest_pain"])
    assert len(outcome.candidates) >= 3
    assert outcome.candidates[0]["disease_code"] == "D1"


def test_match_score_and_probability_are_separate_metrics():
    outcome = _run(["chest_pain", "dyspnea"])
    top = outcome.candidates[0]
    assert 0 < top["match_score"] <= 100
    assert 0 < top["ref_probability"] <= 100
    assert top["match_score"] != top["ref_probability"] or top["ref_probability"] > 0
    assert top["hit_symptoms"]
    assert top["missing_symptoms"]


def test_probabilities_sum_to_100():
    outcome = _run(["chest_pain", "dyspnea"])
    total = sum(item["ref_probability"] for item in outcome.candidates if item["ref_probability"] > 0)
    assert 99.0 <= total <= 101.0


def test_differential_penalty_records_exclusion_reason():
    outcome = _run(["chest_pain", "dyspnea"])
    top = outcome.candidates[0]
    assert any(item["reason"] for item in top["excluded_reasons"])


def test_alert_level_and_disclaimer():
    outcome = _run(["chest_pain", "dyspnea"])
    assert outcome.alert["level"] in {"immediate", "urgent", "elective", "observe"}
    assert "不构成诊断" in outcome.alert["disclaimer"]


def test_insufficient_evidence_downgrades_alert():
    # 仅命中一个次要症状：核心症状不足，提醒等级下调
    outcome = _run(["palpitations"])
    assert outcome.alert["level"] in {"elective", "observe"}
    assert outcome.candidates[0]["evidence_insufficient"] is False
    assert len(outcome.candidates) >= 3


def test_evidence_insufficient_padding_flagged():
    outcome = _run(["constipation"])
    padded = [item for item in outcome.candidates if item["evidence_insufficient"]]
    assert padded, "证据不足时应补足候选并标记"


def test_history_bonus_raises_score():
    without = _run(["chest_pain"]).candidates[0]["match_score"]
    with_history = _run(["chest_pain"], ["疾病甲"]).candidates[0]["match_score"]
    assert with_history > without
