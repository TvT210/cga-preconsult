"""量表中心：清单、详情、版本与评审。"""

from __future__ import annotations

from fastapi import Depends, HTTPException
from sqlalchemy.orm import Session

from app.api import new_router

router = new_router()
from app.core.deps import ROLE_ADMIN, ROLE_DOCTOR, get_current_user, require_roles
from app.db.base import get_db
from app.db.models import ScaleTemplate, ScaleVersion, TemplateApproval, User
from app.services import audit
from app.services.scales_store import get_scale, list_scales

REVIEW_STATES = {"draft_pending_medical_review", "approved", "deprecated"}


@router.get("/scales")
def get_scales(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return list_scales(db)


@router.get("/scales/{code}")
def get_scale_detail(code: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    scale = get_scale(db, code)
    if scale is None:
        raise HTTPException(status_code=404, detail="量表不存在")
    item_count = sum(len(section.get("questions", [])) for section in scale.get("sections", []))
    scale = dict(scale)
    scale["item_count"] = item_count
    scale["ready_for_scoring"] = item_count > 0
    if item_count == 0:
        scale["notice"] = "题库条目待以 WS/T 888—2026 附录 B 原文补录，暂不可采集与计分。"
    return scale


@router.get("/scales/{code}/versions")
def list_versions(code: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = (
        db.query(ScaleVersion)
        .filter(ScaleVersion.scale_code == code)
        .order_by(ScaleVersion.id.desc())
        .all()
    )
    return [
        {
            "id": row.id,
            "scale_code": row.scale_code,
            "version": row.version,
            "reviewer": row.reviewer,
            "comment": row.comment,
            "created_at": row.created_at.isoformat(),
        }
        for row in rows
    ]


@router.post("/scales")
def create_scale(
    payload: dict,
    user: User = Depends(require_roles(ROLE_ADMIN, ROLE_DOCTOR)),
    db: Session = Depends(get_db),
):
    code = (payload.get("code") or "").strip()
    if not code:
        raise HTTPException(status_code=400, detail="量表编号不能为空")
    if db.query(ScaleTemplate).filter(ScaleTemplate.code == code).first():
        raise HTTPException(status_code=400, detail="量表编号已存在")
    row = ScaleTemplate(
        code=code,
        name=payload.get("name", code),
        dimension=payload.get("dimension", ""),
        method=payload.get("method", ""),
        standard_ref=payload.get("standard_ref", ""),
        version=payload.get("version", "0.1.0-draft"),
        review_status=payload.get("review_status", "draft_pending_medical_review"),
        payload=payload,
    )
    db.add(row)
    db.add(
        ScaleVersion(
            scale_code=code,
            version=row.version,
            payload=payload,
            reviewer=user.full_name or user.username,
            comment="新建量表版本",
            created_by=user.id,
        )
    )
    db.commit()
    audit.record(db, user, "create", "scale", code, {"name": row.name})
    db.commit()
    return {"code": code, "id": row.id, "review_status": row.review_status}


@router.put("/scales/{code}/review")
def review_scale(
    code: str,
    payload: dict,
    user: User = Depends(require_roles(ROLE_ADMIN, ROLE_DOCTOR)),
    db: Session = Depends(get_db),
):
    """评审状态变更（题库/规则上线前审批）。"""
    status = payload.get("review_status")
    if status not in REVIEW_STATES:
        raise HTTPException(status_code=400, detail=f"评审状态必须是 {sorted(REVIEW_STATES)}")
    row = db.query(ScaleTemplate).filter(ScaleTemplate.code == code).first()
    if row is None:
        raise HTTPException(status_code=404, detail="量表不存在")
    before = row.review_status
    row.review_status = status
    db.add(
        TemplateApproval(
            target_type="scale",
            target_id=code,
            action=status,
            reviewer=user.full_name or user.username,
            comment=payload.get("comment", ""),
        )
    )
    db.commit()
    audit.record(db, user, "review", "scale", code, {"from": before, "to": status})
    db.commit()
    return {"code": code, "review_status": row.review_status}
