"""大模型对话、定期评估、随访与提醒。"""

from __future__ import annotations

import datetime as dt

from fastapi import Depends, HTTPException
from sqlalchemy.orm import Session

from app.api import new_router

router = new_router()
from app.core.deps import ROLE_ELDER, ensure_patient_access, get_current_user, require_staff
from app.db.base import get_db
from app.db.models import (
    Alert,
    AssessmentScore,
    DialogueSession,
    DialogueTurn,
    Followup,
    Patient,
    PatientMedicalProfile,
    PeriodicAssessment,
    User,
)
from app.services import audit
from app.services.dialogue import SAFETY_DISCLAIMER, generate_periodic_assessment, run_dialogue_turn


def _session_payload(db: Session, session: DialogueSession) -> dict:
    turns = (
        db.query(DialogueTurn).filter(DialogueTurn.session_id == session.id).order_by(DialogueTurn.id).all()
    )
    profile = (
        db.query(PatientMedicalProfile)
        .filter(PatientMedicalProfile.patient_id == session.patient_id)
        .first()
    )
    return {
        "id": session.id,
        "patient_id": session.patient_id,
        "title": session.title,
        "model": session.model,
        "prompt_version": session.prompt_version,
        "created_at": session.created_at.isoformat(),
        "turns": [
            {
                "id": turn.id,
                "role": turn.role,
                "content": turn.content,
                "extracted": turn.extracted,
                "safety_note": turn.safety_note,
                "conflict_flags": turn.conflict_flags,
                "created_at": turn.created_at.isoformat(),
            }
            for turn in turns
        ],
        "profile": _profile_payload(profile),
    }


def _profile_payload(profile: PatientMedicalProfile | None) -> dict:
    if profile is None:
        return {"symptoms": [], "conditions": [], "medications": [], "lifestyle": {}, "chief_complaint": {}}
    return {
        "symptoms": profile.symptoms or [],
        "conditions": profile.conditions or [],
        "medications": profile.medications or [],
        "lifestyle": profile.lifestyle or {},
        "chief_complaint": profile.chief_complaint or {},
        "updated_at": profile.updated_at.isoformat() if profile.updated_at else "",
    }


@router.post("/dialogue/sessions")
def create_dialogue_session(
    payload: dict,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    patient_id = int(payload.get("patient_id") or 0)
    if not patient_id:
        raise HTTPException(status_code=400, detail="缺少 patient_id")
    ensure_patient_access(user, patient_id)
    if db.get(Patient, patient_id) is None:
        raise HTTPException(status_code=404, detail="患者不存在")
    session = DialogueSession(
        patient_id=patient_id,
        title=payload.get("title", "就医前对话"),
        model="mock",
        created_by=user.id,
    )
    db.add(session)
    db.commit()
    db.refresh(session)
    return _session_payload(db, session)


@router.get("/dialogue/sessions/{session_id}")
def get_dialogue_session(
    session_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    session = db.get(DialogueSession, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="对话会话不存在")
    ensure_patient_access(user, session.patient_id)
    return _session_payload(db, session)


@router.post("/dialogue/sessions/{session_id}/messages")
def send_message(
    session_id: int,
    payload: dict,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    session = db.get(DialogueSession, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="对话会话不存在")
    ensure_patient_access(user, session.patient_id)
    content = (payload.get("content") or "").strip()
    if not content:
        raise HTTPException(status_code=400, detail="消息内容不能为空")
    result = run_dialogue_turn(db, session, content, payload.get("proxy"))
    audit.record(db, user, "dialogue", "dialogue_session", session_id, {"chars": len(content)})
    db.commit()
    return result


@router.get("/dialogue/sessions/{session_id}/profile")
def get_profile(
    session_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    session = db.get(DialogueSession, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="对话会话不存在")
    ensure_patient_access(user, session.patient_id)
    profile = (
        db.query(PatientMedicalProfile)
        .filter(PatientMedicalProfile.patient_id == session.patient_id)
        .first()
    )
    return _profile_payload(profile)


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
        query = query.filter(PeriodicAssessment.patient_id == (user.patient_id if user.patient_id is not None else -1))
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


@router.get("/alerts")
def list_alerts(
    patient_id: int = 0,
    status: str = "",
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    query = db.query(Alert)
    if user.role == ROLE_ELDER:
        # 老人只能看到本人数据；未绑定患者时返回空集
        query = query.filter(Alert.patient_id == (user.patient_id if user.patient_id is not None else -1))
    if patient_id:
        ensure_patient_access(user, patient_id)
        query = query.filter(Alert.patient_id == patient_id)
    if status:
        query = query.filter(Alert.status == status)
    rows = query.order_by(Alert.id.desc()).all()
    return [
        {
            "id": row.id,
            "patient_id": row.patient_id,
            "level": row.level,
            "message": row.message,
            "department": row.department,
            "disclaimer": row.disclaimer,
            "status": row.status,
            "handled_by": row.handled_by,
            "handled_at": row.handled_at.isoformat() if row.handled_at else "",
            "handle_comment": row.handle_comment,
            "created_at": row.created_at.isoformat(),
        }
        for row in rows
    ]


@router.post("/alerts/{alert_id}/handle")
def handle_alert(
    alert_id: int,
    payload: dict,
    user: User = Depends(require_staff),
    db: Session = Depends(get_db),
):
    """处理就医提醒。

    action：ack（已知悉）/ escalate（升级处理）/ close（关闭）/ mark_false（标记为误报）/ revoke_false（撤销误报标记）。
    标记误报用于累计「误报率」这一质控指标。
    """
    alert = db.get(Alert, alert_id)
    if alert is None:
        raise HTTPException(status_code=404, detail="提醒不存在")
    action = payload.get("action", "ack")
    if action not in {"ack", "escalate", "close", "mark_false", "revoke_false"}:
        raise HTTPException(status_code=400, detail="action 仅支持 ack / escalate / close / mark_false / revoke_false")
    if action == "mark_false":
        alert.is_false_positive = True
        alert.status = "closed"
    elif action == "revoke_false":
        alert.is_false_positive = False
        alert.status = payload.get("status", "ack")
    else:
        alert.status = action
    alert.handled_by = user.full_name or user.username
    alert.handled_at = dt.datetime.now(dt.timezone.utc)
    alert.handle_comment = payload.get("comment", "")
    db.commit()
    audit.record(db, user, action, "alert", alert_id, {"comment": alert.handle_comment})
    db.commit()
    return {
        "id": alert.id,
        "status": alert.status,
        "is_false_positive": alert.is_false_positive,
        "handled_by": alert.handled_by,
    }
