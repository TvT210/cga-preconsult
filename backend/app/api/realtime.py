"""实时通知（WebSocket）。

场景
----
医护端页面开着的时候，老人完成评估或点「一键呼叫」，医生应当立刻看到提示，
而不是等刷新。HTTP 轮询能做到但延迟高、空请求多；WebSocket 一条长连接就够。

鉴权为什么不用 `Authorization` 头
--------------------------------
浏览器的 `WebSocket` 构造函数不支持自定义请求头，只能带 URL 与子协议。
把 token 放进 query 会被 Nginx/网关的访问日志记下来，是常见的凭证泄露来源。
因此这里采用**握手后首帧鉴权**：连接建立、服务端 `accept()` 之后，客户端在 5 秒内
发一条 `{"token": "..."}`，校验通过才登记到连接表，否则立即以 4401 关闭。

事件格式
--------
    {"type": "assessment.submitted", "at": "2026-11-25T11:30:00+08:00", "data": {...}}

客户端可发送 `{"type": "ping"}` 心跳，服务端回 `{"type": "pong"}`。
"""

from __future__ import annotations

import asyncio
import datetime
import logging
from typing import Any, Iterable

from fastapi import WebSocket, WebSocketDisconnect

from app.api import new_router
from app.core.security import decode_access_token
from app.db.base import SessionLocal
from app.db.models import User

logger = logging.getLogger(__name__)

router = new_router()

AUTH_TIMEOUT_SECONDS = 5.0

# 医疗提醒属于临床结论，只有医护侧角色接收。
CLINICAL_ROLES = ("doctor", "staff", "admin")


class ConnectionManager:
    """按角色维护 WebSocket 连接。

    广播是「尽力而为」：单个连接发送失败（客户端已断开）只做清理，不影响其他连接。
    """

    def __init__(self) -> None:
        self._connections: dict[WebSocket, str] = {}
        self._loop: asyncio.AbstractEventLoop | None = None

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        """记录应用事件循环，供同步路由线程投递广播任务。"""
        self._loop = loop

    def register(self, websocket: WebSocket, role: str) -> None:
        self._connections[websocket] = role

    def unregister(self, websocket: WebSocket) -> None:
        self._connections.pop(websocket, None)

    @property
    def connection_count(self) -> int:
        return len(self._connections)

    async def _broadcast(self, roles: Iterable[str], event: dict[str, Any]) -> int:
        targets = set(roles)
        dead: list[WebSocket] = []
        sent = 0
        for websocket, role in list(self._connections.items()):
            if role not in targets:
                continue
            try:
                await websocket.send_json(event)
                sent += 1
            except Exception:  # noqa: BLE001 — 连接已断时 send 会抛各类异常，统一清理
                dead.append(websocket)
        for websocket in dead:
            self.unregister(websocket)
        return sent

    def notify(self, roles: Iterable[str], event_type: str, data: dict[str, Any] | None = None) -> None:
        """从同步代码调用：把广播投递到事件循环，不阻塞当前请求。

        路由函数大多是同步的（FastAPI 会把它们放进线程池执行），因此不能直接
        `await`。用 `run_coroutine_threadsafe` 投递即可，失败只记日志——
        实时通知失败不应该让「提交评估」这类主流程报错。
        """
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        event = {
            "type": event_type,
            "at": datetime.datetime.now(datetime.timezone.utc).astimezone().isoformat(timespec="seconds"),
            "data": data or {},
        }
        try:
            asyncio.run_coroutine_threadsafe(self._broadcast(roles, event), loop)
        except RuntimeError:
            logger.warning("实时通知投递失败：事件循环不可用", exc_info=True)


manager = ConnectionManager()


def _resolve_user(token: str) -> User | None:
    """校验 token 并取出用户；失败返回 None。"""
    payload = decode_access_token(token or "")
    if not payload:
        return None
    try:
        user_id = int(payload.get("sub") or 0)
    except (TypeError, ValueError):
        return None
    if not user_id:
        return None

    db = SessionLocal()
    try:
        user = db.get(User, user_id)
        if user is None or not user.is_active:
            return None
        # 脱离 session：后续 WebSocket 生命周期里不再访问数据库
        db.expunge(user)
        return user
    finally:
        db.close()


@router.websocket("/ws/notifications")
async def notifications(websocket: WebSocket):
    await websocket.accept()

    # 首帧鉴权：避免 token 出现在 URL 与访问日志里
    try:
        first = await asyncio.wait_for(websocket.receive_json(), timeout=AUTH_TIMEOUT_SECONDS)
    except (asyncio.TimeoutError, WebSocketDisconnect, ValueError):
        await websocket.close(code=4401)
        return

    token = ""
    if isinstance(first, dict):
        token = str(first.get("token") or "")
    user = _resolve_user(token)
    if user is None:
        await websocket.send_json({"type": "error", "message": "登录已失效，请重新登录"})
        await websocket.close(code=4401)
        return

    manager.register(websocket, user.role)
    await websocket.send_json(
        {
            "type": "ready",
            "data": {"user_id": user.id, "role": user.role, "name": user.full_name},
        }
    )

    try:
        while True:
            message = await websocket.receive_json()
            if isinstance(message, dict) and message.get("type") == "ping":
                await websocket.send_json({"type": "pong"})
    except WebSocketDisconnect:
        pass
    except Exception:  # noqa: BLE001 — 非法帧等异常统一断开
        pass
    finally:
        manager.unregister(websocket)
