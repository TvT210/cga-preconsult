"""审计日志与质控指标。"""

from __future__ import annotations

import datetime as dt
from typing import Any

from sqlalchemy.orm import Session

from app.db.models import (
    Alert,
    AssessmentScore,
    AuditLog,
    CgaReport,
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
    """写审计日志（查看、修改、导出、阈值变更、知识库发布）。"""
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


def quality_metrics(db: Session) -> dict[str, Any]:
    """质控指标：计分一致率、匹配准确率、误报率、提醒响应率。"""
    scores = db.query(AssessmentScore).all()
    total_scores = len(scores)
    pending_review = sum(1 for item in scores if item.needs_manual_review and not item.reviewed)
    abnormal = sum(1 for item in scores if item.abnormal)

    runs = db.query(MatchRun).all()
    alerts = db.query(Alert).all()
    handled = sum(1 for item in alerts if item.status in {"ack", "closed", "escalated"})
    escalation = sum(1 for item in alerts if item.status == "escalated")
    triggered = sum(1 for item in alerts if item.level in {"immediate", "urgent"})

    stats = {
        "patients": db.query(Patient).count(),
        "users": db.query(User).count(),
        "assessments": total_scores,
        "abnormal_assessments": abnormal,
        "reports": db.query(CgaReport).count(),
        "match_runs": len(runs),
        "alerts": len(alerts),
        "pending_review": pending_review,
    }

    return {
        "scoring_consistency": None,
        "match_accuracy": None,
        "false_alert_rate": None,
        "alert_response_rate": round(handled / len(alerts), 4) if alerts else None,
        "pending_reviews": pending_review,
        "escalation_count": escalation,
        "triggered_alert_count": triggered,
        "stats": stats,
        "note": "计分一致率、匹配准确率、误报率需在真实标注数据积累后统计，当前留空。",
        "generated_at": dt.datetime.now().isoformat(),
    }
