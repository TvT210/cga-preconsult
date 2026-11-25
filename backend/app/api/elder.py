"""老人端求助通道（**线 A：A-9 适老化**）。

只做一件事：把「老人不会用、需要人来」这件事**记下来并让医护看得见**。

设计边界（刻意保守）：

1. **不写 `alerts`**。就医提醒是医学结论的产物，混进操作层面的求助会污染
   提醒量与误报率口径；
2. **不做自动派单**。系统里没有排班与在岗数据，派给谁都是编的；只标「待处理」，
   由现场人员自行认领；
3. **不编电话**。机构电话取自配置 `CGA_ELDER_HELP_PHONE`，未配置就返回空串，
   前端如实提示「请找身边的工作人员」。
"""

from __future__ import annotations

import datetime as dt

from fastapi import Depends, HTTPException
from sqlalchemy.orm import Session

from app.api import new_router
from app.api import realtime
from app.core.config import settings
from app.core.deps import (
    ROLE_ELDER,
    ensure_patient_access,
    get_current_user,
    require_staff,
)
from app.db.base import get_db
from app.db.models import AssistanceRequest, AssessmentSession, Patient, User

router = new_router()

STATUSES = {"pending", "handled"}
MAX_NOTE = 200


def _serialize(row: AssistanceRequest, patient_name: str = "") -> dict:
    return {
        "id": row.id,
        "patient_id": row.patient_id,
        "patient_name": patient_name,
        "session_id": row.session_id,
        "question_code": row.question_code,
        "note": row.note,
        "status": row.status,
        "handled_by": row.handled_by,
        "handled_at": row.handled_at.isoformat() if row.handled_at else "",
        "handle_comment": row.handle_comment,
        "created_at": row.created_at.isoformat() if row.created_at else "",
    }


@router.get("/elder/support")
def elder_support(user: User = Depends(get_current_user)):
    """老人端求助方式。

    `phone` 为空表示本机构没配电话，前端应提示现场求助，而不是显示空号码。
    """
    phone = (settings.elder_help_phone or "").strip()
    hours = (settings.elder_help_hours or "").strip()
    return {
        "phone": phone,
        "hours": hours,
        "note": (
            "点「呼叫工作人员」后会通知现场人员；如果长时间没人来，"
            "请直接到护士站找工作人员。"
            if phone
            else "点「呼叫工作人员」后会通知现场人员；也可以直接到护士站找人帮忙。"
        ),
    }


@router.post("/elder/assistance")
def create_assistance(
    payload: dict,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """发起协助请求。老人只能为本人发起，医护可代任意患者发起。"""
    patient_id = payload.get("patient_id")
    if user.role == ROLE_ELDER:
        if user.patient_id is None:
            raise HTTPException(status_code=400, detail="当前账号没有绑定老人档案，请联系工作人员")
        patient_id = user.patient_id
    if not patient_id:
        raise HTTPException(status_code=400, detail="缺少 patient_id")
    try:
        patient_id = int(patient_id)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="patient_id 必须是整数")
    ensure_patient_access(user, patient_id)

    patient = db.get(Patient, patient_id)
    if patient is None:
        raise HTTPException(status_code=404, detail="患者不存在")

    session_id = payload.get("session_id")
    if session_id not in (None, "", 0):
        try:
            session_id = int(session_id)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="session_id 必须是整数")
        session = db.get(AssessmentSession, session_id)
        # 只接受同一患者的会话，避免把求助挂到别人的评估上
        if session is None or session.patient_id != patient_id:
            raise HTTPException(status_code=400, detail="会话不存在或不属于该患者")
    else:
        session_id = None

    note = (payload.get("note") or "").strip()
    if len(note) > MAX_NOTE:
        raise HTTPException(status_code=400, detail=f"补充说明不能超过 {MAX_NOTE} 字")

    row = AssistanceRequest(
        patient_id=patient_id,
        session_id=session_id,
        question_code=(payload.get("question_code") or "").strip()[:64],
        note=note,
        status="pending",
        created_by=user.id,
    )
    db.add(row)
    db.commit()
    db.refresh(row)

    # 实时通知医护端：有人按了呼叫，页面应立刻出现提示，不必等刷新或轮询。
    # 失败不影响主流程（notify 内部吞异常并记日志）。
    realtime.manager.notify(
        realtime.CLINICAL_ROLES,
        "assistance.requested",
        {
            "id": row.id,
            "patient_id": patient_id,
            "patient_name": patient.name,
            "question_code": row.question_code,
            "note": row.note,
        },
    )
    return _serialize(row, patient.name)


@router.get("/elder/assistance")
def list_my_assistance(
    status: str = "",
    limit: int = 20,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """查看协助请求。老人只看本人，医护看全部（可按 patient_id 过滤）。"""
    query = db.query(AssistanceRequest)
    if user.role == ROLE_ELDER:
        if user.patient_id is None:
            return []
        query = query.filter(AssistanceRequest.patient_id == user.patient_id)
    if status:
        if status not in STATUSES:
            raise HTTPException(status_code=400, detail="status 只能是 pending 或 handled")
        query = query.filter(AssistanceRequest.status == status)
    rows = query.order_by(AssistanceRequest.id.desc()).limit(max(1, min(limit, 100))).all()
    names = _patient_names(db, {row.patient_id for row in rows})
    return [_serialize(row, names.get(row.patient_id, "")) for row in rows]


@router.get("/assistance")
def list_assistance_for_staff(
    status: str = "pending",
    patient_id: int = 0,
    limit: int = 50,
    user: User = Depends(require_staff),
    db: Session = Depends(get_db),
):
    """医护端协助请求列表，默认只看待处理。"""
    query = db.query(AssistanceRequest)
    if status:
        if status not in STATUSES:
            raise HTTPException(status_code=400, detail="status 只能是 pending 或 handled")
        query = query.filter(AssistanceRequest.status == status)
    if patient_id:
        query = query.filter(AssistanceRequest.patient_id == patient_id)
    rows = query.order_by(AssistanceRequest.id.desc()).limit(max(1, min(limit, 200))).all()
    names = _patient_names(db, {row.patient_id for row in rows})
    return [_serialize(row, names.get(row.patient_id, "")) for row in rows]


@router.post("/assistance/{request_id}/handle")
def handle_assistance(
    request_id: int,
    payload: dict,
    user: User = Depends(require_staff),
    db: Session = Depends(get_db),
):
    """标记已处理。

    重复处理不报错（现场可能两人同时点），但**保留第一个处理人与时间**，
    否则「多久有人响应」的时长会被第二次点击覆盖成 0。
    """
    row = db.get(AssistanceRequest, request_id)
    if row is None:
        raise HTTPException(status_code=404, detail="协助请求不存在")
    if row.status == "handled":
        return _serialize(row)
    row.status = "handled"
    row.handled_by = user.full_name or user.username
    row.handled_at = dt.datetime.now(dt.timezone.utc)
    comment = (payload.get("comment") or "").strip()
    if comment:
        row.handle_comment = comment[:MAX_NOTE]
    db.commit()
    db.refresh(row)
    names = _patient_names(db, {row.patient_id})
    return _serialize(row, names.get(row.patient_id, ""))


def _patient_names(db: Session, ids: set[int]) -> dict[int, str]:
    """一次查询取齐患者姓名，避免逐条查库。"""
    if not ids:
        return {}
    rows = db.query(Patient.id, Patient.name).filter(Patient.id.in_(ids)).all()
    return {row[0]: row[1] for row in rows}
