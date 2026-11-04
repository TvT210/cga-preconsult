"""鉴权与访问控制依赖。

角色：elder（老人/家属）、staff（评估人员）、doctor（医生）、admin（系统管理员）。
老人仅可访问与本人 patient_id 绑定的数据，由服务端强制。
"""

from __future__ import annotations

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.db.base import get_db
from app.db.models import User
from app.core.security import decode_access_token

bearer_scheme = HTTPBearer(auto_error=False)

ROLE_ELDER = "elder"
ROLE_STAFF = "staff"
ROLE_DOCTOR = "doctor"
ROLE_ADMIN = "admin"

STAFF_ROLES = (ROLE_STAFF, ROLE_DOCTOR, ROLE_ADMIN)
CLINICAL_ROLES = (ROLE_DOCTOR, ROLE_ADMIN)


def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    db: Session = Depends(get_db),
) -> User:
    if credentials is None or not credentials.credentials:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="未登录或登录已失效")
    payload = decode_access_token(credentials.credentials)
    if not payload:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="登录凭证无效或已过期")
    user = db.get(User, int(payload.get("sub", 0) or 0))
    if user is None or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="账号不存在或已停用")
    return user


def require_roles(*roles: str):
    allowed = set(roles)

    def _dependency(user: User = Depends(get_current_user)) -> User:
        if user.role not in allowed:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="当前角色无权执行该操作")
        return user

    return _dependency


require_staff = require_roles(*STAFF_ROLES)
require_clinical = require_roles(*CLINICAL_ROLES)
require_admin = require_roles(ROLE_ADMIN)


def ensure_patient_access(user: User, patient_id: int) -> None:
    """老人只能访问本人数据。"""
    if user.role == ROLE_ELDER and user.patient_id != patient_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="无权访问该患者的资料")
