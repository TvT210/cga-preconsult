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


@router.put("/admin/prompt-templates/{template_id}")
def publish_prompt_template(
    template_id: int,
    payload: dict,
    user: User = Depends(require_roles(ROLE_ADMIN)),
    db: Session = Depends(get_db),
):
    """发布提示词新版本。

    规则：**不覆盖历史行**——旧版本置为停用，新版本另起一行，
    这样 `model_runs.prompt_version` 记的版本号始终能对应到一条真实内容，
    事后可复现「某次结论用的是哪版提示词」。
    """
    row = db.query(PromptTemplate).filter(PromptTemplate.id == template_id).first()
    if row is None:
        raise HTTPException(status_code=404, detail="提示词模板不存在")
    content = (payload.get("content") or "").strip()
    if not content:
        raise HTTPException(status_code=422, detail="提示词内容不能为空")

    version = (payload.get("version") or "").strip()
    if not version:
        version = f"{row.version.split('-published')[0]}.published"

    # 同一 code 下只保留一个生效版本
    for other in (
        db.query(PromptTemplate)
        .filter(PromptTemplate.code == row.code, PromptTemplate.active.is_(True))
        .all()
    ):
        other.active = False

    published = PromptTemplate(
        code=row.code,
        name=(payload.get("name") or row.name),
        version=version,
        content=content,
        active=True,
    )
    db.add(published)
    db.flush()
    audit.record(
        db,
        user,
        "publish_prompt_template",
        "prompt_template",
        str(published.id),
        {"code": row.code, "version": version},
    )
    db.commit()
    return {
        "id": published.id,
        "code": published.code,
        "name": published.name,
        "version": published.version,
        "content": published.content,
        "active": True,
        "created_at": published.created_at.isoformat(),
    }
