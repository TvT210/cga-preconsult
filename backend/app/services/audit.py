"""审计日志与质控指标。

质控指标分三类：
1. **可从业务数据直接计算**（完成率、复核率、异常检出率、待确认率、提醒响应率、误报率…）——现在就有数；
2. **需要工作流喂数据**（计分一致率靠「复核是否改分」、误报率靠「标记误报」）——随业务推进自动积累；
3. **必须有人工标注集**（匹配准确率、召回率）——在标注集建成前保持 null，不编造。
"""

from __future__ import annotations

import datetime as dt
from typing import Any

from sqlalchemy.orm import Session

from app.db.models import (
    Alert,
    AssessmentScore,
    AssessmentSession,
    AuditLog,
    CgaReport,
    MatchAiReview,
    MatchCandidate,
    MatchRun,
    Patient,
    User,
)


def record(
    db: Session,
    actor: User | None,
    action: str,
    target_type: str = "",
    target_id: str | int = "",
    detail: dict[str, Any] | None = None,
) -> AuditLog:
    """写审计日志（查看、修改、导出、阈值变更、发布）。"""
    entry = AuditLog(
        actor_id=actor.id if actor else None,
        actor_name=actor.full_name or actor.username if actor else "system",
        action=action,
        target_type=target_type,
        target_id=str(target_id),
        detail=detail or {},
    )
    db.add(entry)
    return entry


def _ratio(numerator: float, denominator: float) -> float | None:
    if not denominator:
        return None
    return round(numerator / denominator, 4)


def _mean(values: list[float]) -> float | None:
    if not values:
        return None
    return round(sum(values) / len(values), 2)


def quality_metrics(db: Session) -> dict[str, Any]:
    """质控指标看板数据。"""
    scores = db.query(AssessmentScore).all()
    sessions = db.query(AssessmentSession).all()
    alerts = db.query(Alert).all()
    runs = db.query(MatchRun).all()
    candidates = db.query(MatchCandidate).all()
    ai_reviews = db.query(MatchAiReview).all()

    # ---- 评估过程 ----
    total_scores = len(scores)
    total_sessions = len(sessions)
    finished_sessions = sum(1 for item in sessions if item.status in {"finished", "reviewed"})
    reviewed_scores = [item for item in scores if item.reviewed]
    abnormal_scores = [item for item in scores if item.abnormal]
    pending_scores = [item for item in scores if item.needs_manual_review and not item.reviewed]

    # 计分一致率：复核后分值与复核前分值不一致的样本视为「计分不一致」
    consistency_samples = [
        item for item in reviewed_scores if item.pre_review_total is not None
    ]
    changed_samples = [
        item
        for item in consistency_samples
        if abs(float(item.total) - float(item.pre_review_total or 0)) > 1e-9
        or (item.pre_review_level or "") != (item.level or "")
    ]

    # ---- 提醒闭环 ----
    handled = sum(1 for item in alerts if item.status in {"ack", "closed", "escalated"})
    escalated = sum(1 for item in alerts if item.status == "escalated")
    triggered = [item for item in alerts if item.level in {"immediate", "urgent"}]
    false_positives = [item for item in alerts if item.is_false_positive]

    # ---- 匹配效果 ----
    top_scores: list[float] = []
    gaps: list[float] = []
    by_run: dict[int, list[Any]] = {}
    for candidate in candidates:
        by_run.setdefault(candidate.run_id, []).append(candidate)
    for rows in by_run.values():
        ordered = sorted(rows, key=lambda item: item.rank)
        if ordered:
            top_scores.append(float(ordered[0].match_score or 0))
            if len(ordered) > 1:
                gaps.append(round(float(ordered[0].match_score or 0) - float(ordered[1].match_score or 0), 2))
    hit_diseases = {candidate.disease_code for candidate in candidates}

    # ---- 疾病库覆盖 ----
    from app.services.disease_library import list_diseases

    library_size = len(list_diseases(db))

    # ---- 量表维度分布 ----
    scale_stats: dict[str, dict[str, int]] = {}
    for score in scores:
        bucket = scale_stats.setdefault(score.scale_code, {"total": 0, "abnormal": 0, "pending": 0})
        bucket["total"] += 1
        if score.abnormal:
            bucket["abnormal"] += 1
        if score.needs_manual_review and not score.reviewed:
            bucket["pending"] += 1

    stats = {
        "patients": db.query(Patient).count(),
        "users": db.query(User).count(),
        "assessments": total_scores,
        "abnormal_assessments": len(abnormal_scores),
        "reports": db.query(CgaReport).count(),
        "match_runs": len(runs),
        "alerts": len(alerts),
        "pending_review": len(pending_scores),
        "ai_reviews": len(ai_reviews),
    }

    return {
        # 评估过程
        "assessment_completion_rate": _ratio(finished_sessions, total_sessions),
        "review_rate": _ratio(len(reviewed_scores), total_scores),
        "abnormal_detection_rate": _ratio(len(abnormal_scores), total_scores),
        "pending_confirmation_rate": _ratio(len(pending_scores), total_scores),
        # 计分一致率（由「复核是否改分」喂养）
        "scoring_consistency": (
            _ratio(len(consistency_samples) - len(changed_samples), len(consistency_samples))
            if consistency_samples
            else None
        ),
        "scoring_consistency_samples": len(consistency_samples),
        # 提醒闭环
        "alert_response_rate": _ratio(handled, len(alerts)),
        "alert_escalation_rate": _ratio(escalated, len(alerts)),
        "high_level_alert_ratio": _ratio(len(triggered), len(alerts)),
        # 误报率（由医护「标记误报」喂养）
        "false_alert_rate": _ratio(len(false_positives), len(triggered)),
        "false_alert_samples": len(false_positives),
        # 匹配效果
        "match_accuracy": None,  # 需要人工标注集，暂不编造
        "match_recall": None,  # 需要人工标注集，暂不编造
        "top1_match_score_avg": _mean(top_scores),
        "top1_top2_gap_avg": _mean(gaps),
        "ai_review_coverage": _ratio(len(ai_reviews), len(runs)),
        "disease_library_coverage": _ratio(len(hit_diseases), library_size),
        "disease_library_size": library_size,
        "disease_hit_count": len(hit_diseases),
        "scale_stats": scale_stats,
        "stats": stats,
        "note": (
            "计分一致率、误报率随「复核改分」与「标记误报」自动积累；"
            "匹配准确率与召回率需要人工标注集，暂无数据故留空。"
        ),
        "generated_at": dt.datetime.now().isoformat(),
    }
