"""AI 复核层与质控指标测试。"""

from __future__ import annotations

from app.services.ai_review import _extract_json, _mock_review
from app.services.audit import quality_metrics


def test_extract_json_handles_code_fence():
    text = '```json\n{"rerank": [{"disease_code": "I21"}]}\n```'
    parsed = _extract_json(text)
    assert parsed and parsed["rerank"][0]["disease_code"] == "I21"


def test_extract_json_handles_surrounding_prose():
    text = '好的，结果如下：{"follow_ups": []} 希望有帮助。'
    parsed = _extract_json(text)
    assert parsed is not None and "follow_ups" in parsed


def test_extract_json_returns_none_on_garbage():
    assert _extract_json("完全没有 JSON") is None


def test_mock_review_produces_rerank_and_followups():
    candidates = [
        {
            "disease_code": "I21",
            "disease_name": "急性心肌梗死",
            "match_score": 52.6,
            "hit_symptoms": [{"code": "chest_pain", "term": "胸痛胸闷", "weight": "core"}],
            "missing_symptoms": [{"code": "palpitations", "term": "心悸", "weight": "core"}],
            "red_flags": [{"code": "chest_pain", "term": "持续胸痛", "note": "立即就医"}],
        },
        {
            "disease_code": "I10",
            "disease_name": "高血压急症",
            "match_score": 88.6,
            "hit_symptoms": [{"code": "dyspnea", "term": "呼吸困难", "weight": "core"}],
            "missing_symptoms": [],
            "red_flags": [],
        },
    ]
    review = _mock_review({"candidates": candidates}, candidates)
    assert review.rerank, "应给出排序建议"
    assert review.rerank[0]["ai_rank"] == 1
    # 命中红旗征的候选在 AI 建议里排前面
    assert review.rerank[0]["disease_code"] == "I21"
    assert review.follow_ups, "应给出补充问诊建议"
    assert review.explanations
    assert "不构成诊断" in review.notice


def test_ai_review_never_changes_scores():
    """AI 只给建议：输出结构里不含分值/等级字段。"""
    candidates = [
        {
            "disease_code": "I21",
            "disease_name": "急性心肌梗死",
            "match_score": 52.6,
            "hit_symptoms": [],
            "missing_symptoms": [],
            "red_flags": [],
        }
    ]
    review = _mock_review({"candidates": candidates}, candidates)
    payload = review.to_dict()
    for item in payload["rerank"]:
        assert "match_score" not in item
        assert "level" not in item
        assert "risk_level" not in item


def test_quality_metrics_are_computable():
    """质控指标应返回可计算的数值（而非全部 null）。"""
    from app.db.base import SessionLocal
    from app.db.init_db import init_db

    init_db(seed=True)
    db = SessionLocal()
    try:
        metrics = quality_metrics(db)
    finally:
        db.close()

    for key in (
        "assessment_completion_rate",
        "review_rate",
        "abnormal_detection_rate",
        "alert_response_rate",
        "high_level_alert_ratio",
        "false_alert_rate",
        "ai_review_coverage",
        "disease_library_coverage",
        "scale_stats",
        "stats",
    ):
        assert key in metrics, f"缺少质控指标 {key}"
    assert metrics["match_accuracy"] is None, "匹配准确率需标注集，应保持 None"
    assert isinstance(metrics["scale_stats"], dict)
