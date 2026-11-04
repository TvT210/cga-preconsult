"""定期自动评估与随访计划（**线 B：结论与运营**）。

- 定期自动评估：基于老人专属医疗数据库生成「AI 补充评估」，生产由 Celery Beat 定时触发；
- 随访计划：按风险等级生成复评周期与重点跟踪项，完成后回填结果。
"""

from __future__ import annotations

import datetime as dt

from fastapi import Depends, HTTPException
from sqlalchemy.orm import Session

from app.api import new_router
from app.core.deps import ROLE_ELDER, ensure_patient_access, get_current_user, require_staff
from app.db.base import get_db
from app.db.models import Followup, Patient, PeriodicAssessment, User
from app.services.dialogue import generate_periodic_assessment

router = new_router()


@router.post("/periodic/run")
def run_periodic(
    payload: dict,
    user: User = Depends(require_staff),
    db: Session = Depends(get_db),
):
    """手动触发定期自动评估（生产由 Celery Beat 定时触发）。"""
    patient_id = int(payload.get("patient_id") or 0)
    if not patient_id:
        raise HTTPException(status_code=400, detail="缺少 patient_id")
    if db.get(Patient, patient_id) is None:
        raise HTTPException(status_code=404, detail="患者不存在")
    record = generate_periodic_assessment(db, patient_id)
    return {
        "id": record.id,
        "patient_id": record.patient_id,
        "dimension_conclusions": record.dimension_conclusions,
        "trend": record.trend,
        "model": record.model,
        "prompt_version": record.prompt_version,
        "generated_at": record.generated_at.isoformat(),
        "notice": record.notice,
    }


@router.get("/periodic")
def list_periodic(
    patient_id: int = 0,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    query = db.query(PeriodicAssessment)
    if user.role == ROLE_ELDER:
        # 老人只能看到本人数据；未绑定患者时返回空集
        query = query.filter(
            PeriodicAssessment.patient_id == (user.patient_id if user.patient_id is not None else -1)
        )
    if patient_id:
        ensure_patient_access(user, patient_id)
        query = query.filter(PeriodicAssessment.patient_id == patient_id)
    rows = query.order_by(PeriodicAssessment.id.desc()).all()
    return [
        {
            "id": row.id,
            "patient_id": row.patient_id,
            "dimension_conclusions": row.dimension_conclusions,
            "trend": row.trend,
            "model": row.model,
            "notice": row.notice,
            "generated_at": row.generated_at.isoformat(),
        }
        for row in rows
    ]


@router.get("/followups")
def list_followups(
    patient_id: int = 0,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    query = db.query(Followup)
    if user.role == ROLE_ELDER:
        # 老人只能看到本人数据；未绑定患者时返回空集
        query = query.filter(Followup.patient_id == (user.patient_id if user.patient_id is not None else -1))
    if patient_id:
        ensure_patient_access(user, patient_id)
        query = query.filter(Followup.patient_id == patient_id)
    rows = query.order_by(Followup.id.desc()).all()
    return [
        {
            "id": row.id,
            "patient_id": row.patient_id,
            "interval_days": row.interval_days,
            "focus_items": row.focus_items,
            "due_at": row.due_at.isoformat() if row.due_at else "",
            "status": row.status,
            "note": row.note,
            "result": row.result,
            "created_at": row.created_at.isoformat(),
        }
        for row in rows
    ]


@router.post("/followups")
def create_followup(
    payload: dict,
    user: User = Depends(require_staff),
    db: Session = Depends(get_db),
):
    patient_id = int(payload.get("patient_id") or 0)
    if not patient_id:
        raise HTTPException(status_code=400, detail="缺少 patient_id")
    interval_days = int(payload.get("interval_days") or 30)
    due_at = dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=interval_days)
    followup = Followup(
        patient_id=patient_id,
        interval_days=interval_days,
        focus_items=payload.get("focus_items") or [],
        due_at=due_at,
        status="planned",
        note=payload.get("note", ""),
    )
    db.add(followup)
    db.commit()
    db.refresh(followup)
    return {"id": followup.id, "patient_id": patient_id, "due_at": followup.due_at.isoformat()}


@router.post("/followups/{followup_id}/complete")
def complete_followup(
    followup_id: int,
    payload: dict,
    user: User = Depends(require_staff),
    db: Session = Depends(get_db),
):
    followup = db.get(Followup, followup_id)
    if followup is None:
        raise HTTPException(status_code=404, detail="随访计划不存在")
    followup.status = "completed"
    followup.result = payload.get("result", "")
    followup.completed_at = dt.datetime.now(dt.timezone.utc)
    db.commit()
    return {"id": followup.id, "status": followup.status, "result": followup.result}
