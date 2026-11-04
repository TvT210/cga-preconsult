"""系统管理：账号、审计、质控、看板与提示词模板。"""

from __future__ import annotations

from fastapi import Depends, HTTPException
from sqlalchemy.orm import Session

from app.api import new_router

router = new_router()
from app.core.deps import ROLE_ADMIN, get_current_user, require_roles
from app.core.security import hash_password
from app.db.base import get_db
from app.db.models import AuditLog, PromptTemplate, User
from app.services import audit
from app.services.audit import quality_metrics


@router.get("/admin/users")
def list_users(user: User = Depends(require_roles(ROLE_ADMIN)), db: Session = Depends(get_db)):
    rows = db.query(User).order_by(User.id).all()
    return [
        {
            "id": row.id,
            "username": row.username,
            "full_name": row.full_name,
            "role": row.role,
            "department": row.department,
            "patient_id": row.patient_id,
            "is_active": row.is_active,
            "created_at": row.created_at.isoformat(),
        }
        for row in rows
    ]


@router.post("/admin/users")
def create_user(
    payload: dict,
    user: User = Depends(require_roles(ROLE_ADMIN)),
    db: Session = Depends(get_db),
):
    username = (payload.get("username") or "").strip()
    password = payload.get("password") or ""
    role = payload.get("role") or "staff"
    if not username or not password:
        raise HTTPException(status_code=400, detail="账号与密码不能为空")
    if role not in {"elder", "staff", "doctor", "admin"}:
        raise HTTPException(status_code=400, detail="角色无效")
    if db.query(User).filter(User.username == username).first():
        raise HTTPException(status_code=400, detail="账号已存在")
    row = User(
        username=username,
        password_hash=hash_password(password),
        full_name=payload.get("full_name", ""),
        role=role,
        department=payload.get("department", ""),
        patient_id=payload.get("patient_id"),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    audit.record(db, user, "create", "user", row.id, {"username": username, "role": role})
    db.commit()
    return {"id": row.id, "username": username, "role": role}


@router.get("/admin/audit-logs")
def list_audit_logs(
    actor: str = "",
    target: str = "",
    action: str = "",
    limit: int = 100,
    user: User = Depends(require_roles(ROLE_ADMIN)),
    db: Session = Depends(get_db),
):
    query = db.query(AuditLog)
    if actor:
        query = query.filter(AuditLog.actor_name.like(f"%{actor}%"))
    if target:
        query = query.filter(AuditLog.target_id == target)
    if action:
        query = query.filter(AuditLog.action == action)
    rows = query.order_by(AuditLog.id.desc()).limit(min(limit, 500)).all()
    return [
        {
            "id": row.id,
            "actor_name": row.actor_name,
            "action": row.action,
            "target_type": row.target_type,
            "target_id": row.target_id,
            "detail": row.detail,
            "created_at": row.created_at.isoformat(),
        }
        for row in rows
    ]


@router.get("/admin/quality-metrics")
def get_quality_metrics(user: User = Depends(require_roles(ROLE_ADMIN)), db: Session = Depends(get_db)):
    return quality_metrics(db)


@router.get("/admin/stats/overview")
def stats_overview(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    metrics = quality_metrics(db)
    return metrics["stats"] | {"generated_at": metrics["generated_at"]}


@router.get("/admin/prompt-templates")
def list_prompt_templates(user: User = Depends(require_roles(ROLE_ADMIN)), db: Session = Depends(get_db)):
    rows = db.query(PromptTemplate).order_by(PromptTemplate.id).all()
    return [
        {
            "id": row.id,
            "code": row.code,
            "name": row.name,
            "version": row.version,
            "content": row.content,
            "active": row.active,
            "created_at": row.created_at.isoformat(),
        }
        for row in rows
    ]
