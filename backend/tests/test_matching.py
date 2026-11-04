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


# ---------------------------------------------------------------------------
# 疾病库 schema v2：保护性征象 / 红旗征 / 高危因素
# ---------------------------------------------------------------------------

DISEASE_V2 = {
    "code": "V1",
    "name": "病甲",
    "aliases": [],
    "system": "测试",
    "risk_level": "immediate",
    "review_status": "draft_pending_medical_review",
    "payload": {
        "risk_level": "immediate",
        "symptoms": [
            {"code": "chest_pain", "weight": "core"},
            {"code": "dyspnea", "weight": "core"},
            {"code": "palpitations", "weight": "secondary"},
        ],
        "protective_signs": [
            {"code": "fever", "term": "发热", "note": "发热更支持感染性疾病"},
        ],
        "red_flags": [
            {"code": "syncope", "term": "晕厥", "note": "出现即需立即就医"},
        ],
        "risk_factors": [
            {"code": "smoking_history", "factor": "吸烟", "detail": "动脉粥样硬化基础"},
            {"factor": "高龄", "detail": "症状不典型"},
        ],
        "differentials": [],
        "advice": {"department": "内科", "urgency": "立即就医", "text": "请立即就医。"},
    },
}


def _run_v2(codes: list[str]):
    evidence = build_evidence([], [{"code": code} for code in codes], [])
    return run_matching([DISEASE_V2], evidence, WEIGHTS, {"global": 60.0})


def test_protective_sign_lowers_match_score():
    base = _run_v2(["chest_pain", "dyspnea"]).candidates[0]["match_score"]
    with_fever = _run_v2(["chest_pain", "dyspnea", "fever"]).candidates[0]["match_score"]
    assert with_fever < base, "命中保护性征象应降低匹配度"


def test_protective_sign_is_recorded_as_exclusion_reason():
    outcome = _run_v2(["chest_pain", "dyspnea", "fever"])
    reasons = " ".join(item["reason"] for item in outcome.candidates[0]["excluded_reasons"])
    assert "保护性征象" in reasons


def test_red_flag_blocks_downgrade():
    """命中红旗征时，即使核心症状不足也不得降级提醒等级。"""
    outcome = _run_v2(["syncope"])
    assert outcome.alert["level"] == "immediate"
    assert outcome.candidates[0]["red_flags"], "红旗征应写入候选"
    assert "红旗征" in outcome.alert["message"]


def test_red_flag_absent_allows_downgrade():
    outcome = _run_v2(["palpitations"])
    assert outcome.alert["level"] in {"elective", "observe"}
    assert outcome.candidates[0]["red_flags"] == []


def test_risk_factor_hit_is_reported():
    outcome = _run_v2(["chest_pain", "dyspnea", "smoking_history"])
    hits = outcome.candidates[0]["risk_factor_hits"]
    assert hits and hits[0]["factor"] == "吸烟"


# ---------------------------------------------------------------------------
# 区分度加权 / 症状组合 / 区分性症状
# ---------------------------------------------------------------------------

SHARED = "fatigue"  # 两个病都有的共享症状
UNIQUE = "chest_pain"  # 只有病甲有的独有症状


def _two_diseases() -> list[dict]:
    def make(code: str, name: str, unique_code: str) -> dict:
        return {
            "code": code,
            "name": name,
            "aliases": [],
            "system": "测试",
            "risk_level": "urgent",
            "review_status": "draft_pending_medical_review",
            "payload": {
                "risk_level": "urgent",
                "symptoms": [
                    {"code": unique_code, "weight": "core"},
                    {"code": SHARED, "weight": "core"},
                ],
                "differentials": [],
                "advice": {"department": "内科", "urgency": "尽快就医", "text": "请就医。"},
            },
        }

    return [make("D1", "病甲", UNIQUE), make("D2", "病乙", "cough")]


def test_shared_symptom_has_lower_distinctive_multiplier():
    """共享症状的区分度系数应低于独有症状（相对比较，不与固定基准比）。"""
    evidence = build_evidence([], [{"code": SHARED}], [])
    shared_outcome = run_matching(_two_diseases(), evidence, WEIGHTS, {"global": 60.0})
    shared_points = next(
        item["points"] for item in shared_outcome.candidates[0]["hit_symptoms"] if item["code"] == SHARED
    )

    unique_evidence = build_evidence([], [{"code": UNIQUE}], [])
    unique_outcome = run_matching(_two_diseases(), unique_evidence, WEIGHTS, {"global": 60.0})
    unique_points = next(
        item["points"] for item in unique_outcome.candidates[0]["hit_symptoms"] if item["code"] == UNIQUE
    )
    assert unique_points > shared_points, "独有症状权重应高于共享症状"

    # 关闭区分度加权后，两者都回到基准权重
    flat = MatchingWeights(**{**WEIGHTS.__dict__, "distinctive_weighting": False})
    flat_outcome = run_matching(_two_diseases(), evidence, flat, {"global": 60.0})
    flat_points = next(
        item["points"] for item in flat_outcome.candidates[0]["hit_symptoms"] if item["code"] == SHARED
    )
    assert abs(flat_points - WEIGHTS.core) < 1e-6


def test_distinctive_and_shared_symptoms_are_annotated():
    """只命中本候选的症状标为区分性，多个候选共有的标为共享。"""
    evidence = build_evidence([], [{"code": UNIQUE}, {"code": SHARED}], [])
    outcome = run_matching(_two_diseases(), evidence, WEIGHTS, {"global": 60.0})
    top = outcome.candidates[0]
    assert any(item["code"] == UNIQUE for item in top["distinctive_symptoms"])
    assert any(item["code"] == SHARED for item in top["shared_symptoms"])
    shared = next(item for item in top["shared_symptoms"] if item["code"] == SHARED)
    assert "D2" in shared["shared_with"]


def test_pattern_hit_gives_bonus():
    """症状组合全中时额外加分。"""
    diseases = _two_diseases()
    diseases[0]["payload"]["patterns"] = [
        {"symptoms": [UNIQUE, SHARED], "bonus": 3.0, "note": "组合命中"}
    ]
    evidence = build_evidence([], [{"code": UNIQUE}, {"code": SHARED}], [])
    with_pattern = run_matching(diseases, evidence, WEIGHTS, {"global": 60.0})
    diseases[0]["payload"].pop("patterns")
    without = run_matching(diseases, evidence, WEIGHTS, {"global": 60.0})
    assert with_pattern.candidates[0]["raw_score"] > without.candidates[0]["raw_score"]
    assert with_pattern.candidates[0]["pattern_hits"]
    assert with_pattern.candidates[0]["pattern_hits"][0]["term"] == "组合命中"
