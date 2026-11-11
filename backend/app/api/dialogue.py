"""大模型对话（**线 A：采集与判读**）。

只包含对话采集相关端点；定期评估、随访、就医提醒属线 B，已分别迁至
`api/followups.py` 与 `api/alerts.py`。

流式与非流式的分工（A-7）：
- 非流式 ``POST /messages`` 保持原样，一次性返回完整结果；
- 流式 ``POST /messages/stream`` 用 SSE 逐段吐字，**收尾事件与非流式字段完全一致**，
  两端共用 ``prepare_turn`` / ``finalize_turn``，只有「文本怎么产生」不同。
"""

from __future__ import annotations

import json
import time
from typing import Iterator

from fastapi import Depends, HTTPException
from fastapi.responses import StreamingResponse
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
from app.services.dialogue import (
    FALLBACK_NETWORK,
    FALLBACK_REPEAT,
    check_safety,
    finalize_turn,
    prepare_turn,
    run_dialogue_turn,
)
from packages.medagent.llm import LLMEmptyResponse, stream_chat


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


def _sse(payload: dict) -> str:
    """一帧 SSE：``data: {...}`` 加空行。中文不转义，抓包即可直接读。"""
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def _stream_turn(
    db: Session,
    session: DialogueSession,
    content: str,
    proxy: dict | None,
    user: User,
) -> Iterator[str]:
    """把一轮对话切成 SSE 事件流。

    事件序列（详见 ``docs/api-contract.md`` §8）::

        data: {"safety_note": "…", "done": false}    # 仅当用户这句话命中急症规则
        data: {"reply": "增量文本", "done": false}   # 若干帧
        data: {"reply": "全文", "done": true, …}     # 收尾，字段与非流式一致

    安全提示前置发送是有意为之：急症警告不该等模型把话说完才出现。
    """
    ctx = prepare_turn(db, session, content, proxy)
    early_note = check_safety(content)
    if early_note:
        yield _sse({"safety_note": early_note, "done": False})

    started = time.perf_counter()
    pieces: list[str] = []
    persisted = False
    try:
        try:
            for piece in stream_chat(ctx.provider, ctx.messages):
                pieces.append(piece)
                yield _sse({"reply": piece, "done": False})
            latency = int((time.perf_counter() - started) * 1000)
            # stream_chat 在「一个字都没产出」时抛 LLMEmptyResponse，
            # 所以走到这里的 reply 必然非空，无需再判空。
            result = finalize_turn(db, ctx, "".join(pieces), latency)
        except LLMEmptyResponse as exc:
            latency = int((time.perf_counter() - started) * 1000)
            if pieces:
                # 说到一半模型没了：保留已说出的内容并标记中断。
                # 不能替换成兜底话术——前后文会自相矛盾，医护也会误当成完整回复。
                result = finalize_turn(db, ctx, "".join(pieces), latency, str(exc), interrupted=True)
            else:
                result = finalize_turn(db, ctx, FALLBACK_REPEAT, latency, str(exc))
        except Exception as exc:
            latency = int((time.perf_counter() - started) * 1000)
            detail = f"{type(exc).__name__}: {exc}"
            if pieces:
                result = finalize_turn(db, ctx, "".join(pieces), latency, detail, interrupted=True)
            else:
                result = finalize_turn(db, ctx, FALLBACK_NETWORK, latency, detail)

        audit.record(
            db, user, "dialogue", "dialogue_session", session.id, {"chars": len(content), "stream": True}
        )
        db.commit()
        persisted = True
        yield _sse({**result, "done": True})
    finally:
        if not persisted:
            # 客户端断开（老人关页面、切网络、点「停止」）：已生成的部分照样入库并
            # 标记中断；一个字都没出时也把这条用户消息存下——老人说过什么不能丢。
            try:
                finalize_turn(
                    db,
                    ctx,
                    "".join(pieces),
                    int((time.perf_counter() - started) * 1000),
                    model_error="client_disconnected",
                    interrupted=True,
                )
            except Exception:  # 断开后再抛错没有接收方，回滚即可
                db.rollback()


@router.post("/dialogue/sessions/{session_id}/messages/stream")
def stream_message(
    session_id: int,
    payload: dict,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """SSE 流式对话（A-7），字段与非流式完全一致。

    会话存在、权限、内容非空三项校验全部在推流之前完成：一旦开始推流状态码
    就固定为 200，参数错误只能用事件表达，不如提前用 4xx 挡掉。
    """
    session = db.get(DialogueSession, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="对话会话不存在")
    ensure_patient_access(user, session.patient_id)
    content = (payload.get("content") or "").strip()
    if not content:
        raise HTTPException(status_code=400, detail="消息内容不能为空")
    return StreamingResponse(
        _stream_turn(db, session, content, payload.get("proxy"), user),
        media_type="text/event-stream",
        headers={
            # 反向代理若缓冲，逐字效果会退化成「等半天再整段蹦出来」
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )


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
