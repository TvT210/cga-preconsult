"""就医提醒处理（**线 B：结论与运营**）。

提醒的**生成**在匹配引擎（`services/matching.py`），这里负责**处理闭环**：
已知悉 / 升级 / 关闭 / 标记误报。其中「标记误报」用于累计「误报率」这一质控指标。
"""

from __future__ import annotations

import datetime as dt

from fastapi import Depends, HTTPException
from sqlalchemy.orm import Session

from app.api import new_router
from app.core.deps import ROLE_ELDER, ensure_patient_access, get_current_user, require_staff
from app.db.base import get_db
from app.db.models import Alert, User
from app.services import audit

router = new_router()


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
            "is_false_positive": row.is_false_positive,
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

    action：ack（已知悉）/ escalate（升级处理）/ close（关闭）/
    mark_false（标记为误报，用于累计误报率）/ revoke_false（撤销误报标记）。
    """
    alert = db.get(Alert, alert_id)
    if alert is None:
        raise HTTPException(status_code=404, detail="提醒不存在")
    action = payload.get("action", "ack")
    if action not in {"ack", "escalate", "close", "mark_false", "revoke_false"}:
        raise HTTPException(
            status_code=400, detail="action 仅支持 ack / escalate / close / mark_false / revoke_false"
        )
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
