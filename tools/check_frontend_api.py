#!/usr/bin/env python
"""前端调用 ↔ 后端端点 一致性检查。

作用
----
扫描 `frontend/src/**/*.ts(x)` 里所有 `api.get/post/put/patch/delete(...)` 与
`request(path, { method })` 调用，取出请求路径，与 FastAPI 应用实际注册的
`/api/v1/*` 路由逐一比对，报出「前端调了、后端没有」的路径。

这类问题在前后端分离项目里非常常见：前端看起来正常，点下去才 404。
本脚本不启动服务，直接导入 app 对象读路由表，因此可以放进 CI。

用法
----
    python tools/check_frontend_api.py
    python tools/check_frontend_api.py --strict   # 有问题时退出码 1

比较方式
--------
按「路径形状」而非参数名比较：`/patients/${patientId}` 会归一化成
`/patients/{}`，后端的 `/patients/{patient_id}` 同样归一化成 `/patients/{}`，
二者视为一致。避免参数命名不同造成误报。
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND_DIR = REPO_ROOT / "backend"
FRONTEND_SRC = REPO_ROOT / "frontend" / "src"
API_PREFIX = "/api/v1"

# 前端调用形态：
#   api.get<T>("/patients", {...})
#   api.post(`/assessments/${id}/answers`, body)
#   request<T>(`/matching/runs/${id}`, { method: "GET" })
PAT_API = re.compile(
    r"""api\.(get|post|put|patch|delete)\s*(?:<[^(]*?>)?\s*\(\s*\n?\s*[`"']([^`"']+)[`"']""",
    re.S,
)
# request<T>(path, { method: "POST" })。method 缺省时按 GET 处理，
# 因此选项对象整体作为可选捕获组，再从其中提取 method。
PAT_REQ = re.compile(
    r"""request\s*(?:<[^(]*?>)?\s*\(\s*\n?\s*[`"']([^`"']+)[`"']\s*(?:,\s*\{([^{}]*)\})?""",
    re.S,
)
PAT_METHOD = re.compile(r"""method:\s*"(\w+)\"""")

# buildUrl(`/reports/${id}/export`, {...}) —— 封装过的下载类调用，不经过 api.*，
# 若只扫 api.* 会把「导出」这类接口误判成「前端未使用」。这类调用一律按 GET 计。
PAT_BUILD_URL = re.compile(r"""buildUrl\s*\(\s*\n?\s*[`"']([^`"']+)[`"']""", re.S)

# 前端路径里的模板变量 `${...}` 归一化为 `{}`
PAT_TPL = re.compile(r"\$\{[^}]+\}")


def _shape(path: str) -> str:
    """把路径归一化成形状：变量段统一成 {}，去掉查询串。"""
    path = path.split("?")[0].rstrip("/") or "/"
    return re.sub(r"\{[^}]+\}", "{}", path)


def load_backend_routes() -> set[tuple[str, str]]:
    """导入 FastAPI 应用，收集 /api/v1 下所有 (METHOD, 路径形状)。

    不遍历 app.routes：新版 FastAPI 的 include_router 会产生嵌套的
    `_IncludedRouter` 对象，没有直接的 path 属性。改为生成 OpenAPI schema，
    其中 paths 已是拼接完整的最终路径，且不启动服务。
    """
    sys.path.insert(0, str(BACKEND_DIR))
    from app.main import app  # noqa: E402  (需先加 sys.path)

    schema = app.openapi()
    routes: set[tuple[str, str]] = set()
    for path, operations in schema.get("paths", {}).items():
        if not path.startswith(API_PREFIX):
            continue
        for method in operations:
            if method.upper() in {"HEAD", "OPTIONS"}:
                continue
            routes.add((method.upper(), _shape(path[len(API_PREFIX):])))
    return routes


def scan_frontend_calls() -> list[tuple[str, str, str]]:
    """扫描前端源码，返回 [(文件, 方法, 原始路径)]。"""
    calls: list[tuple[str, str, str]] = []
    # buildUrl 出现在封装函数里时看不出方法，先单独收集，最后只补「别处没出现过」的路径，
    # 否则像 /dialogue/sessions/{}/messages/stream 这种实际上是 POST 的会被误记成 GET。
    url_calls: list[tuple[str, str, str]] = []
    if not FRONTEND_SRC.exists():
        return calls
    for file in sorted(list(FRONTEND_SRC.rglob("*.ts")) + list(FRONTEND_SRC.rglob("*.tsx"))):
        if ".test." in file.name:
            continue
        text = file.read_text(encoding="utf-8", errors="ignore")
        for m in PAT_API.finditer(text):
            calls.append((file.name, m.group(1).upper(), m.group(2)))
        for m in PAT_REQ.finditer(text):
            opts = m.group(2) or ""
            method_match = PAT_METHOD.search(opts)
            method = method_match.group(1).upper() if method_match else "GET"
            calls.append((file.name, method, m.group(1)))
        for m in PAT_BUILD_URL.finditer(text):
            # 方法写在紧随其后的选项对象里（fetch(buildUrl(...), { method: "POST" })），
            # 取一小段窗口向后找；找不到就按 GET（下载类接口都是 GET）。
            window = text[m.end() : m.end() + 240]
            found = PAT_METHOD.search(window)
            url_calls.append((file.name, found.group(1).upper() if found else "GET", m.group(1)))

    # 只补录「还没有任何调用命中同一路径形状」的那些，避免生成假报错
    seen = {_shape(PAT_TPL.sub("{}", raw)) for _, _, raw in calls}
    for file_name, method, raw in url_calls:
        shape = _shape(PAT_TPL.sub("{}", raw))
        if shape in seen:
            continue
        seen.add(shape)
        calls.append((file_name, method, raw))
    return calls


def main() -> int:
    parser = argparse.ArgumentParser(description="检查前端调用是否都有后端端点")
    parser.add_argument("--strict", action="store_true", help="发现不一致时返回退出码 1")
    args = parser.parse_args()

    backend = load_backend_routes()
    calls = scan_frontend_calls()

    if not calls:
        print("[!] 未在前端源码中发现任何 API 调用，检查路径是否正确：", FRONTEND_SRC)
        return 1 if args.strict else 0

    matched: list[tuple[str, str, str]] = []
    missing: list[tuple[str, str, str]] = []
    for fname, method, raw in calls:
        if not raw.startswith("/"):
            continue
        shape = _shape(PAT_TPL.sub("{}", raw))
        (matched if (method, shape) in backend else missing).append((fname, method, raw))

    print(f"后端 /api/v1 端点形状: {len(backend)}")
    print(f"前端调用: {len(calls)}  匹配: {len(matched)}  未匹配: {len(missing)}")

    if missing:
        print("\n后端不存在的前端调用：")
        for fname, method, raw in sorted(set(missing)):
            print(f"  {method:7s} {raw:48s} <- {fname}")

    unused = sorted(backend - {(m, _shape(PAT_TPL.sub("{}", r))) for _, m, r in matched})
    if unused:
        print(f"\n后端有实现但前端未调用（{len(unused)} 个，仅供参考，不算错误）：")
        for method, shape in unused[:20]:
            print(f"  {method:7s} {shape}")

    if missing and args.strict:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
