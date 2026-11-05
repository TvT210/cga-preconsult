"""GitHub 推送工具：自动探测可用通道并重试。

背景（2026-11-05 实测）：
本机访问 GitHub 依赖加速器（127.0.0.1:7897）。加速器没开时，直连
github.com:443 不通，`git push` 直接失败（"Failed to connect to github.com
port 443"）；开了之后直连通常即可用，但**经代理时 git 的 TLS 握手会报**
`SSL routines::unexpected eof`，需要同时指定 `http.sslBackend=schannel`
（用 Windows 原生 TLS 栈）才能推上去。

因此本脚本按以下顺序自动选择通道：
1. 直连可用 → 直接推；
2. 直连不通、代理可用 → 带 `http.proxy` + `http.sslBackend=schannel` 推；
3. 都不通 → 明确提示「请先开启加速器」，不做无谓重试。

用法：
    python tools/push_github.py [分支] [重试次数]
默认分支 dev、重试 5 次（每次间隔 10 秒）。
"""

from __future__ import annotations

import pathlib
import socket
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
PROXY_HOST = "127.0.0.1"
PROXY_PORT = 7897
PROXY_URL = f"http://{PROXY_HOST}:{PROXY_PORT}"


def tcp_ok(host: str, port: int, timeout: float = 4.0) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def push(branch: str, use_proxy: bool) -> tuple[int, str]:
    cmd = ["git", "push", "origin", branch]
    if use_proxy:
        cmd = [
            "git",
            "-c", f"http.proxy={PROXY_URL}",
            "-c", f"https.proxy={PROXY_URL}",
            # 走代理时 git 自带的 OpenSSL 握手会断，改用 Windows 原生 TLS
            "-c", "http.sslBackend=schannel",
            "push", "origin", branch,
        ]
    result = subprocess.run(
        cmd,
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    return result.returncode, ((result.stdout or "") + (result.stderr or "")).strip()


def main() -> int:
    branch = sys.argv[1] if len(sys.argv) > 1 else "dev"
    attempts = int(sys.argv[2]) if len(sys.argv) > 2 else 5

    direct = tcp_ok("github.com", 443)
    proxy = tcp_ok(PROXY_HOST, PROXY_PORT)
    print(f"通道检测：直连 github.com:443 = {direct}；代理 {PROXY_URL} = {proxy}", flush=True)

    if not direct and not proxy:
        print("两条通道都不可用——请先开启加速器后重试。", flush=True)
        return 2

    # 直连优先；直连不通时用代理
    use_proxy = not direct
    for index in range(1, attempts + 1):
        code, output = push(branch, use_proxy)
        channel = "代理" if use_proxy else "直连"
        if code == 0:
            print(f"[第 {index} 次/{channel}] PUSH_OK: {output[-200:]}", flush=True)
            return 0
        print(f"[第 {index} 次/{channel}] 失败: {output[-200:]}", flush=True)

        # 通道可能在两次尝试之间变化（用户开关加速器），重新探测
        if not tcp_ok("github.com", 443) and tcp_ok(PROXY_HOST, PROXY_PORT):
            use_proxy = True
        time.sleep(10)

    print("最终仍未推送成功。", flush=True)
    return 1


if __name__ == "__main__":
    sys.exit(main())
