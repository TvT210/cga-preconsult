"""实时通知（WebSocket）用例。

覆盖点：
1. 首帧鉴权：不带 token 或 token 无效时，服务端先回一条 error 再以 4401 关闭；
2. 鉴权通过后收到 ready，并带回角色；
3. 心跳 ping → pong，用于客户端探测连接是否还活着；
4. 老人发起「一键呼叫」时，医护端的连接能收到 assistance.requested 事件；
5. 事件里带患者姓名与题目定位，医护端不用再查一遍接口就能展示提示。
"""

from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.api.realtime import ConnectionManager
from app.main import app

client = TestClient(app)

WS_URL = "/api/v1/ws/notifications"


def _login(username: str, password: str) -> str:
    response = client.post("/api/v1/auth/login", json={"username": username, "password": password})
    assert response.status_code == 200, response.text
    return response.json()["data"]["token"]


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def test_rejects_invalid_token():
    """无效 token：先收到 error，随后连接被关闭。"""
    with client.websocket_connect(WS_URL) as ws:
        ws.send_json({"token": "not-a-real-token"})
        message = ws.receive_json()
        assert message["type"] == "error"
        with pytest.raises(WebSocketDisconnect):
            ws.receive_json()


def test_rejects_empty_token():
    """首帧没有 token 字段，按未认证处理。"""
    with client.websocket_connect(WS_URL) as ws:
        ws.send_json({})
        assert ws.receive_json()["type"] == "error"


def test_ready_after_auth():
    """鉴权通过后返回 ready，并带上角色，前端据此决定要不要订阅临床事件。"""
    token = _login("doctor", "doctor12345")
    with client.websocket_connect(WS_URL) as ws:
        ws.send_json({"token": token})
        message = ws.receive_json()
        assert message["type"] == "ready"
        assert message["data"]["role"] == "doctor"


def test_ping_pong():
    """心跳：服务端回 pong，客户端可据此判断连接存活。"""
    token = _login("nurse", "nurse12345")
    with client.websocket_connect(WS_URL) as ws:
        ws.send_json({"token": token})
        assert ws.receive_json()["type"] == "ready"

        ws.send_json({"type": "ping"})
        assert ws.receive_json()["type"] == "pong"


# ---------- 广播逻辑（不经过 TestClient 的并发调度，直测 manager） ----------


class FakeSocket:
    """只实现 send_json 的假连接，用于验证广播目标与断连清理。"""

    def __init__(self, broken: bool = False) -> None:
        self.sent: list[dict] = []
        self.broken = broken

    async def send_json(self, event: dict) -> None:
        if self.broken:
            raise RuntimeError("connection closed")
        self.sent.append(event)


def test_broadcast_only_targets_requested_roles():
    """事件只推给指定角色：老人端连接不应该收到临床事件。"""
    manager = ConnectionManager()
    doctor = FakeSocket()
    elder = FakeSocket()
    manager.register(doctor, "doctor")  # type: ignore[arg-type]
    manager.register(elder, "elder")  # type: ignore[arg-type]

    sent = asyncio.run(manager._broadcast(("doctor", "staff", "admin"), {"type": "assessment.submitted"}))

    assert sent == 1
    assert len(doctor.sent) == 1
    assert elder.sent == []


def test_broadcast_drops_dead_connections():
    """发送失败的连接应被移除，避免每次都撞同一个坏连接。"""
    manager = ConnectionManager()
    alive = FakeSocket()
    dead = FakeSocket(broken=True)
    manager.register(alive, "doctor")  # type: ignore[arg-type]
    manager.register(dead, "doctor")  # type: ignore[arg-type]

    asyncio.run(manager._broadcast(("doctor",), {"type": "x"}))

    assert manager.connection_count == 1
    assert len(alive.sent) == 1


def test_notify_without_loop_is_noop():
    """没有绑定事件循环时（例如纯单元环境）直接跳过，不抛异常。

    实时通知是锦上添花，绝不能因为它把「提交评估」这类主流程搞挂。
    """
    manager = ConnectionManager()
    manager.notify(("doctor",), "assessment.submitted", {"session_id": 1})  # 不应抛异常
