"""手机扫码接入 · 局域网地址探测用例。

覆盖点：
1. 未登录不可访问（该接口给已登录用户拼二维码用）；
2. 返回结构稳定：hostname / primary / addresses / has_lan 四字段；
3. `addresses` 永不包含回环与链路本地地址——手机拿这些地址是连不上的；
4. `primary` 要么为空，要么就是 `addresses[0]`，前端据此决定优先用哪个生成二维码；
5. `has_lan` 与 `addresses` 是否为空严格一致，前端据此决定要不要提示「无局域网地址」；
6. 默认路由出口地址排在最前，网段次序作为备选；避免虚拟网卡的 `192.168.x.1`
   抢在真实出口前面；
7. `_is_usable_lan_ip` 的边界判断。
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.api.system_info import _default_route_ip, _is_usable_lan_ip, _sort_key, collect_lan_addresses
from app.main import app

client = TestClient(app)


def _login(username: str = "elder", password: str = "elder12345") -> str:
    response = client.post("/api/v1/auth/login", json={"username": username, "password": password})
    assert response.status_code == 200, response.text
    return response.json()["data"]["token"]


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def test_requires_login():
    """未登录直接 401，不泄露本机网络信息。"""
    response = client.get("/api/v1/system/lan-addresses")
    assert response.status_code == 401


def test_returns_expected_shape():
    data = client.get("/api/v1/system/lan-addresses", headers=_auth(_login())).json()["data"]

    assert set(data) == {"hostname", "primary", "addresses", "has_lan"}
    assert isinstance(data["hostname"], str)
    assert isinstance(data["addresses"], list)
    assert isinstance(data["has_lan"], bool)


def test_excludes_loopback_and_link_local():
    """回环与 169.254 链路本地地址不能出现在结果里。"""
    data = client.get("/api/v1/system/lan-addresses", headers=_auth(_login())).json()["data"]

    for ip in data["addresses"]:
        assert not ip.startswith("127."), f"回环地址不该出现：{ip}"
        assert not ip.startswith("169.254."), f"链路本地地址不该出现：{ip}"
        assert ip.count(".") == 3, f"应为 IPv4 点分十进制：{ip}"


def test_primary_is_first_address():
    """primary 必须等于 addresses[0]，否则前端会展示一个和列表不一致的主地址。"""
    data = client.get("/api/v1/system/lan-addresses", headers=_auth(_login())).json()["data"]

    if data["addresses"]:
        assert data["primary"] == data["addresses"][0]
    else:
        assert data["primary"] is None


def test_has_lan_matches_addresses():
    """has_lan 必须与 addresses 是否为空一致，否则前端会给出无效二维码或误报无网。"""
    data = client.get("/api/v1/system/lan-addresses", headers=_auth(_login())).json()["data"]
    assert data["has_lan"] is bool(data["addresses"])


def test_collect_returns_unique_and_primary_first():
    addresses = collect_lan_addresses()
    assert len(addresses) == len(set(addresses)), "地址不应重复"

    primary = _default_route_ip()
    if primary and primary in addresses:
        assert addresses[0] == primary, "默认路由出口地址应排第一"


def test_sort_prefers_192_168():
    """作为备选地址排序时，192.168 段应排在 10 段与 172.16-31 段之前。"""
    ordered = sorted(["172.20.1.5", "10.0.0.8", "192.168.1.7"], key=_sort_key)
    assert ordered == ["192.168.1.7", "10.0.0.8", "172.20.1.5"]


def test_usable_ip_boundaries():
    assert _is_usable_lan_ip("192.168.1.5") is True
    assert _is_usable_lan_ip("10.1.2.3") is True
    assert _is_usable_lan_ip("172.20.0.9") is True

    assert _is_usable_lan_ip("127.0.0.1") is False
    assert _is_usable_lan_ip("169.254.10.10") is False
    assert _is_usable_lan_ip("0.0.0.0") is False
    assert _is_usable_lan_ip("") is False
    assert _is_usable_lan_ip("192.168.1") is False
    assert _is_usable_lan_ip("::1") is False
