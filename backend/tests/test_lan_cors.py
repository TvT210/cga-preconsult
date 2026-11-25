"""局域网来源的 CORS 用例。

手机扫码后页面来自 `http://192.168.x.x:3000`，与本地开发的
`http://127.0.0.1:3000` 不同源。如果后端只放行固定白名单，手机端**所有**
API 请求都会被浏览器拦掉，表现是页面打开了一片空白、控制台报 CORS。

这里验证三件事：
1. 私有网段来源（192.168 / 10 / 172.16-31）能通过预检并回显 Origin；
2. 回环来源仍然正常（不影响本地开发）；
3. 公网来源不被放行，避免把接口暴露给任意站点。
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)

PREFLIGHT_HEADERS = {
    "Access-Control-Request-Method": "GET",
    "Access-Control-Request-Headers": "authorization",
}


def _preflight(origin: str):
    headers = dict(PREFLIGHT_HEADERS)
    headers["Origin"] = origin
    return client.options("/api/v1/auth/me", headers=headers)


def test_private_network_origin_allowed():
    """家庭/办公室路由器常见网段，手机多半落在这里。"""
    for origin in (
        "http://192.168.1.5:3000",
        "http://192.168.31.100:3000",
        "http://10.0.0.8:3000",
        "http://172.20.1.5:3000",
    ):
        response = _preflight(origin)
        assert response.status_code == 200, origin
        assert response.headers.get("access-control-allow-origin") == origin, origin


def test_loopback_origin_still_allowed():
    """本地开发不受影响。"""
    for origin in ("http://127.0.0.1:3000", "http://localhost:3000"):
        response = _preflight(origin)
        assert response.status_code == 200, origin
        assert response.headers.get("access-control-allow-origin") == origin, origin


def test_public_origin_rejected():
    """公网来源不应被放行。"""
    response = _preflight("http://evil.example.com")
    assert response.headers.get("access-control-allow-origin") is None


def test_private_origin_on_actual_request():
    """实际请求也要带上允许头，否则浏览器读完响应仍会丢弃。"""
    origin = "http://192.168.1.5:3000"
    response = client.get("/api/v1/auth/me", headers={"Origin": origin})
    assert response.headers.get("access-control-allow-origin") == origin
