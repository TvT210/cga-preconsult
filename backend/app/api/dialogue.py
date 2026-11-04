"""大模型对话（**线 A：采集与判读**）。

只包含对话采集相关端点；定期评估、随访、就医提醒属线 B，已分别迁至
`api/followups.py` 与 `api/alerts.py`。
"""

from __future__ import annotations

from fastapi import Depends, HTTPException
from sqlalchemy.orm import Session

from app.api import new_router

router = new_router()
from app.core.deps import ensure_patient_access, get_current_user
from app.db.base import get_db
from app.db.models import (
    DialogueSession,
    DialogueTurn,
    Patient,
    PatientMedicalProfile,
    User,
)
from app.services import audit
from app.services.dialogue import run_dialogue_turn


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
