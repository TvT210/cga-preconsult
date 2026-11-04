"""医护复核与结论裁决（**线 B：结论与运营**）。

复核 = 医护对线 A 产出的判读结果做裁决与修正，属结论侧，故与采集侧分离。
复核时记录**改分前的判读结果**，用于计算「计分一致率」这一质控指标
（复核中发生改分的样本视为计分不一致）。

数据修正调用线 A 的 `api/assessments.py` 内部的作答写入逻辑，
通过公开的内部函数 `_apply_answer` / `_score_and_store` 复用，避免重复实现计分规则。
"""

from __future__ import annotations

import datetime as dt

from fastapi import Depends, HTTPException
from sqlalchemy.orm import Session

from app.api import new_router
from app.api.assessments import _apply_answer, _score_and_store
from app.core.deps import require_staff
from app.db.base import get_db
from app.db.models import AssessmentScore, AssessmentSession, User
from app.services import audit

router = new_router()


@router.post("/assessments/{session_id}/review")
def review_assessment(
    session_id: int,
    payload: dict,
    user: User = Depends(require_staff),
    db: Session = Depends(get_db),
):
    """医护复核：可修正单题取值后重新计分。"""
    session = db.get(AssessmentSession, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="评估任务不存在")
    action = payload.get("action", "approve")
    corrections = payload.get("corrections") or []
    # 记录复核前的判读结果，用于计算计分一致率（复核改分 = 计分不一致的样本）
    existing = (
        db.query(AssessmentScore)
        .filter(AssessmentScore.session_id == session.id)
        .first()
    )
    pre_review_total = existing.total if existing else None
    pre_review_level = existing.level if existing else ""
    for correction in corrections:
        code = correction.get("question_code")
        if not code:
            continue
        _apply_answer(
            db,
            session,
            code,
            correction.get("value"),
            correction.get("measured"),
            bool(correction.get("proxy_flag")),
            correction.get("answered_by", ""),
        )
    score, branches = _score_and_store(db, session)
    score.reviewed = True
    if pre_review_total is not None:
        score.pre_review_total = pre_review_total
        score.pre_review_level = pre_review_level
    session.status = "reviewed"
    session.reviewer_id = user.id
    session.review_comment = payload.get("comment", "")
    session.reviewed_at = dt.datetime.now(dt.timezone.utc)
    db.commit()
    audit.record(
        db,
        user,
        "review",
        "assessment",
        session.id,
        {"action": action, "corrections": len(corrections), "comment": payload.get("comment", "")},
    )
    db.commit()
    return {
        "session_id": session.id,
        "status": session.status,
        "score": {
            "total": score.total,
            "level": score.level,
            "interpretation": score.interpretation,
            "abnormal": score.abnormal,
            "flags": score.flags,
            "rule_refs": score.rule_refs,
            "needs_manual_review": score.needs_manual_review,
        },
        "branches": branches,
    }
