"""患者、预问诊、知情同意与时间轴。"""

from __future__ import annotations

import datetime as dt

from fastapi import Depends, HTTPException
from sqlalchemy.orm import Session

from app.api import new_router, paginate

router = new_router()
from app.core.deps import ROLE_ELDER, ensure_patient_access, get_current_user, require_staff
from app.db.base import get_db
from app.db.models import (
    Alert,
    AssessmentScore,
    Consent,
    CgaReport,
    DialogueTurn,
    Followup,
    Patient,
    Preconsult,
    User,
)
from app.services import audit


def _mask_id_card(value: str) -> str:
    value = (value or "").strip()
    if len(value) < 8:
        return value
    return value[:3] + "*" * (len(value) - 7) + value[-4:]


def _patient_payload(patient: Patient) -> dict:
    return {
        "id": patient.id,
        "code": patient.code,
        "name": patient.name,
        "gender": patient.gender,
        "birth_date": patient.birth_date.isoformat() if patient.birth_date else "",
        "age": patient.age,
        "phone": patient.phone,
        "id_card_masked": patient.id_card_masked,
        "address": patient.address,
        "emergency_contact": patient.emergency_contact,
        "created_at": patient.created_at.isoformat() if patient.created_at else "",
    }


@router.get("/patients")
def list_patients(
    keyword: str = "",
    page: int = 1,
    size: int = 20,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    query = db.query(Patient)
    if user.role == ROLE_ELDER:
        if user.patient_id is None:
            return paginate([], page, size)
        query = query.filter(Patient.id == user.patient_id)
    if keyword:
        like = f"%{keyword}%"
        query = query.filter((Patient.name.like(like)) | (Patient.code.like(like)) | (Patient.phone.like(like)))
    items = [_patient_payload(row) for row in query.order_by(Patient.id.desc()).all()]
    return paginate(items, page, size)


@router.post("/patients")
def create_patient(
    payload: dict,
    user: User = Depends(require_staff),
    db: Session = Depends(get_db),
):
    name = (payload.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="姓名不能为空")
    count = db.query(Patient).count()
    patient = Patient(
        code=f"P{count + 1:04d}",
        name=name,
        gender=payload.get("gender", ""),
        birth_date=_parse_date(payload.get("birth_date")),
        phone=payload.get("phone", ""),
        id_card_masked=_mask_id_card(payload.get("id_card", "")),
        address=payload.get("address", ""),
        emergency_contact=payload.get("emergency_contact", ""),
        created_by=user.id,
    )
    db.add(patient)
    db.commit()
    db.refresh(patient)
    audit.record(db, user, "create", "patient", patient.id, {"name": patient.name})
    db.commit()
    return _patient_payload(patient)


def _parse_date(value) -> dt.date | None:
    if not value:
        return None
    if isinstance(value, dt.date):
        return value
    try:
        return dt.date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


@router.get("/patients/{patient_id}")
def get_patient(
    patient_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ensure_patient_access(user, patient_id)
    patient = db.get(Patient, patient_id)
    if patient is None:
        raise HTTPException(status_code=404, detail="患者不存在")
    audit.record(db, user, "view", "patient", patient_id)
    db.commit()
    return _patient_payload(patient)


@router.put("/patients/{patient_id}")
def update_patient(
    patient_id: int,
    payload: dict,
    user: User = Depends(require_staff),
    db: Session = Depends(get_db),
):
    patient = db.get(Patient, patient_id)
    if patient is None:
        raise HTTPException(status_code=404, detail="患者不存在")
    for field in ("name", "gender", "phone", "address", "emergency_contact"):
        if field in payload and payload[field] is not None:
            setattr(patient, field, payload[field])
    if "birth_date" in payload:
        patient.birth_date = _parse_date(payload["birth_date"])
    if "id_card" in payload and payload["id_card"]:
        patient.id_card_masked = _mask_id_card(payload["id_card"])
    db.commit()
    audit.record(db, user, "update", "patient", patient_id, {"fields": list(payload.keys())})
    db.commit()
    return _patient_payload(patient)


@router.get("/patients/{patient_id}/preconsult")
def get_preconsult(
    patient_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ensure_patient_access(user, patient_id)
    row = db.query(Preconsult).filter(Preconsult.patient_id == patient_id).first()
    return row.payload if row else {}


@router.put("/patients/{patient_id}/preconsult")
def save_preconsult(
    patient_id: int,
    payload: dict,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """字段级增量保存（自动保存草稿）。"""
    ensure_patient_access(user, patient_id)
    patient = db.get(Patient, patient_id)
    if patient is None:
        raise HTTPException(status_code=404, detail="患者不存在")
    row = db.query(Preconsult).filter(Preconsult.patient_id == patient_id).first()
    if row is None:
        row = Preconsult(patient_id=patient_id, payload={})
        db.add(row)
    for section, value in (payload or {}).items():
        if isinstance(value, dict):
            current = dict(row.payload.get(section) or {})
            current.update(value)
            row.payload = {**row.payload, section: current}
        else:
            row.payload = {**row.payload, section: value}
    row.updated_by = user.id
    db.commit()
    return row.payload


@router.post("/patients/{patient_id}/consent")
def create_consent(
    patient_id: int,
    payload: dict,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ensure_patient_access(user, patient_id)
    agreed = bool(payload.get("agreed"))
    consent = Consent(
        patient_id=patient_id,
        agreed=agreed,
        scope=payload.get("scope", "评估、报告生成与就医提醒"),
        ai_involved=bool(payload.get("ai_involved", True)),
        operator_id=user.id,
        withdrawn_at=dt.datetime.now(dt.timezone.utc) if not agreed else None,
    )
    db.add(consent)
    db.commit()
    db.refresh(consent)
    audit.record(db, user, "consent", "patient", patient_id, {"agreed": agreed})
    db.commit()
    return {
        "id": consent.id,
        "patient_id": patient_id,
        "agreed": consent.agreed,
        "scope": consent.scope,
        "ai_involved": consent.ai_involved,
        "created_at": consent.created_at.isoformat(),
    }


@router.get("/patients/{patient_id}/consents")
def list_consents(
    patient_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ensure_patient_access(user, patient_id)
    rows = db.query(Consent).filter(Consent.patient_id == patient_id).order_by(Consent.id.desc()).all()
    return [
        {
            "id": row.id,
            "agreed": row.agreed,
            "scope": row.scope,
            "ai_involved": row.ai_involved,
            "created_at": row.created_at.isoformat(),
            "withdrawn_at": row.withdrawn_at.isoformat() if row.withdrawn_at else "",
        }
        for row in rows
    ]


@router.get("/patients/{patient_id}/timeline")
def timeline(
    patient_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ensure_patient_access(user, patient_id)
    events: list[dict] = []

    for score in db.query(AssessmentScore).filter(AssessmentScore.patient_id == patient_id).all():
        events.append(
            {
                "time": score.created_at.isoformat(),
                "type": "assessment",
                "title": f"量表评估 {score.scale_code}",
                "detail": f"{score.level}｜{score.interpretation}",
            }
        )
    for report in db.query(CgaReport).filter(CgaReport.patient_id == patient_id).all():
        events.append(
            {
                "time": report.created_at.isoformat(),
                "type": "report",
                "title": f"生成评估报告 v{report.version}",
                "detail": report.title,
            }
        )
    for alert in db.query(Alert).filter(Alert.patient_id == patient_id).all():
        events.append(
            {
                "time": alert.created_at.isoformat(),
                "type": "alert",
                "title": f"就医提醒 [{alert.level}]",
                "detail": alert.message,
            }
        )
    for followup in db.query(Followup).filter(Followup.patient_id == patient_id).all():
        events.append(
            {
                "time": (followup.due_at or followup.created_at).isoformat(),
                "type": "followup",
                "title": "随访计划",
                "detail": followup.note or f"{followup.interval_days} 天后复评",
            }
        )
    events.sort(key=lambda item: item["time"], reverse=True)
    return events
