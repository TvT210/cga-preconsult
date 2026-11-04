"""认证路由。"""

from __future__ import annotations

from fastapi import Depends, HTTPException
from sqlalchemy.orm import Session

from app.api import new_router

router = new_router()
from app.core.deps import get_current_user
from app.core.security import create_access_token, verify_password
from app.db.base import get_db
from app.db.models import User


def _public_user(user: User) -> dict:
    return {
        "id": user.id,
        "username": user.username,
        "full_name": user.full_name,
        "role": user.role,
        "department": user.department,
        "patient_id": user.patient_id,
    }


@router.post("/auth/login")
def login(payload: dict, db: Session = Depends(get_db)):
    username = (payload.get("username") or "").strip()
    password = payload.get("password") or ""
    if not username or not password:
        raise HTTPException(status_code=400, detail="请输入账号与密码")
    user = db.query(User).filter(User.username == username).first()
    if user is None or not user.is_active or not verify_password(password, user.password_hash):
        raise HTTPException(status_code=401, detail="账号或密码不正确")
    token = create_access_token(str(user.id), user.role, {"username": user.username})
    return {"token": token, "token_type": "bearer", "user": _public_user(user)}


@router.get("/auth/me")
def me(user: User = Depends(get_current_user)):
    return _public_user(user)
