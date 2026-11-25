"""本机网络信息路由。

给「手机扫码继续填写」用：老人在电脑上开始填表，想换到手机上继续时，
前端需要知道这台机器在局域网里的地址，才能拼出手机可访问的 URL 并生成二维码。

为什么必须由后端提供
--------------------
浏览器无法查询本机的局域网 IP（WebRTC 拿到的候选地址在新版浏览器里已被脱敏，
不可靠）。而服务端一条 `socket` 就能拿到，这正是网络编程里「枚举本机网卡地址」
的典型场景。

实现要点
--------
用 UDP `connect` 探测默认路由出口地址：UDP 是无连接的，`connect` 只是让内核
选一张网卡并记录对端，**不会真的发出任何数据包**，因此不需要外网连通，也
不会产生流量。拿不到时回退到主机名解析。
"""

from __future__ import annotations

import socket

from fastapi import Depends

from app.api import new_router
from app.core.deps import get_current_user
from app.db.models import User

router = new_router()

# 用于让内核选出默认出口网卡的探测目标（不会实际发包）
_PROBE_TARGETS = ("8.8.8.8", "1.1.1.1", "223.5.5.5")

# 这些网段不可能是「手机能访问到的」局域网地址
_EXCLUDED_PREFIXES = ("127.", "169.254.", "0.")


def _is_usable_lan_ip(ip: str) -> bool:
    """判断是否为可被同网段设备访问的 IPv4 地址。"""
    if not ip or ip.count(".") != 3:
        return False
    return not ip.startswith(_EXCLUDED_PREFIXES)


def _sort_key(ip: str) -> tuple[int, str]:
    """排序优先级：192.168 > 10 > 172.16-31 > 其他。家庭/办公室路由器多用 192.168。"""
    if ip.startswith("192.168."):
        return (0, ip)
    if ip.startswith("10."):
        return (1, ip)
    if ip.startswith("172."):
        try:
            second = int(ip.split(".")[1])
        except ValueError:
            return (3, ip)
        if 16 <= second <= 31:
            return (2, ip)
    return (3, ip)


def _default_route_ip() -> str | None:
    """探测默认路由出口地址。

    UDP 是无连接的，`connect` 只让内核选一张网卡并记下对端，**不会真的发包**，
    因此不要求外网连通，也不产生流量。这个地址对应的网卡一定是能出网的，
    用它当「主地址」比按网段猜可靠得多。
    """
    for target in _PROBE_TARGETS:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
                probe.settimeout(0.3)
                probe.connect((target, 80))
                ip = probe.getsockname()[0]
            if _is_usable_lan_ip(ip):
                return ip
        except OSError:
            continue
    return None


def collect_lan_addresses() -> list[str]:
    """收集本机局域网 IPv4 地址，默认路由出口地址排在最前。

    排序不能只看网段。Windows 上装了 VMware / VirtualBox / WSL 后，网卡列表里会
    多出若干 `192.168.x.1` 这类宿主机虚拟地址，但它们手机是连不上的。因此把
    「默认路由出口」置顶，其余按网段可能性排序作为备选。
    """
    primary = _default_route_ip()
    found: set[str] = set()
    if primary:
        found.add(primary)

    # 主机名解析（多网卡、虚拟网卡时能补全备选地址）
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            found.add(info[4][0])
    except OSError:
        pass

    usable = [ip for ip in found if _is_usable_lan_ip(ip)]
    return sorted(usable, key=lambda ip: (0 if ip == primary else 1, _sort_key(ip)))


@router.get("/system/lan-addresses")
def lan_addresses(user: User = Depends(get_current_user)):
    """返回本机可被手机访问的局域网地址，供前端生成二维码。

    - `primary`：默认路由出口地址，优先用它生成二维码；为空表示探测失败。
    - `addresses`：全部可用地址，`primary` 一定排第一，其余作为备选让用户手动切换
      （虚拟网卡可能被选中，切换入口由前端提供）。
    - `has_lan`：为 False 表示没有任何可用局域网地址，前端应提示改用本机填写，
      而不是给出一个扫了也打不开的二维码。
    """
    addresses = collect_lan_addresses()
    try:
        hostname = socket.gethostname()
    except OSError:
        hostname = ""
    return {
        "hostname": hostname,
        "primary": addresses[0] if addresses else None,
        "addresses": addresses,
        "has_lan": bool(addresses),
    }
