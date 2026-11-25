"""契约一致性校验：`docs/api-contract.md` 声明 vs FastAPI 实际路由（B-4）。

为什么需要它：契约已经迭代到 CA-20261118-04，全靠人肉对齐。一旦某天有人
改了 `@router.get` 的路径却忘了改契约（或反之），前端会按契约写代码，联调时才炸。
这个脚本把「对不上」提前到 CI。

三种判定：
- **契约有、代码没有** → 红灯。前端按契约写必然 404，这是真事故。
- **代码有、契约没有** → 黄灯。不阻断，但会列出来（可能是内部接口，也可能真漏了）。
- 两者都有但方法不同 → 红灯（同样会 405）。

用法：
    python tools/contract_diff.py              # 只对「契约有代码无」报警
    python tools/contract_diff.py --strict     # 漏写契约也报警
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = REPO_ROOT / "backend"
CONTRACT = REPO_ROOT / "docs" / "api-contract.md"
API_PREFIX = "/api/v1"
# 基础设施端点，不属于业务契约（根路径与健康检查）
IGNORED = {("GET", "/"), ("GET", "/health")}

METHODS = ("GET", "POST", "PUT", "PATCH", "DELETE")
HEADING = re.compile(r"^#{2,4}\s+(.+)$")
# 成组端点用表格写：| POST | `/elder/assistance` | 角色 | 说明 |
TABLE_ROW = re.compile(r"^\|\s*(GET|POST|PUT|PATCH|DELETE)\s*\|\s*`([^`]+)`")
PATH_TOKEN = re.compile(r"`(/[^`]*)`")
BARE_PATH = re.compile(r"(?<![\w`])(/[a-z0-9{}/_\-]+)")


def parse_contract(text: str) -> set[tuple[str, str]]:
    """从标题里抠出 (方法, 路径)。标题是这个文档唯一稳定的结构标记。"""
    found: set[tuple[str, str]] = set()
    for line in text.splitlines():
        row = TABLE_ROW.match(line)
        if row:
            found.add((row.group(1), _shape(_normalize(row.group(2)))))
            continue

        m = HEADING.match(line)
        if not m:
            continue
        heading = m.group(1)
        if not any(method in heading for method in METHODS):
            continue

        # 一个标题里可能写多个端点：「GET / PUT `/x`」「GET `/x` · PUT `/x`」。
        # 逐个路径找，方法取「上一个路径之后、本路径之前」出现的方法词，
        # 这样路径后面的说明（→ 形态 A、裸数组）不会被当成方法。
        cursor = 0
        for token in list(PATH_TOKEN.finditer(heading)) or []:
            path = token.group(1)
            if not path.startswith("/"):
                cursor = token.end()
                continue
            before = heading[cursor : token.start()]
            methods = re.findall(r"\b(GET|POST|PUT|PATCH|DELETE)\b", before)
            for method in methods:
                found.add((method, _shape(_normalize(path))))
            cursor = token.end()
    return found


def parse_openapi() -> set[tuple[str, str]]:
    sys.path.insert(0, str(BACKEND_DIR))
    from app.main import app  # noqa: E402  导入期不建库、不连库

    found: set[tuple[str, str]] = set()
    for path, operations in app.openapi().get("paths", {}).items():
        for method in operations:
            if method.upper() in METHODS:
                found.add((method.upper(), _shape(_normalize(path))))
    return found


def _normalize(path: str) -> str:
    path = path.split("?")[0]
    if path.startswith(API_PREFIX):
        path = path[len(API_PREFIX) :]
    return "/" + path.strip("/")


def _shape(path: str) -> str:
    """把路径参数名抹平：/{session_id} 与 /{id} 是同一个路由。

    不抹平的话，第一次跑就会有 10 条假红灯——契约写 `{id}`、代码写 `{session_id}`，
    端点其实都在。参数名不一致另做提示，不和「端点缺失」混为一谈。
    """
    return re.sub(r"\{[^}]*\}", "{}", path)


def main(argv: list[str]) -> int:
    strict = "--strict" in argv
    if not CONTRACT.exists():
        print(f"契约文件不存在：{CONTRACT}")
        return 2

    contract = parse_contract(CONTRACT.read_text(encoding="utf-8"))
    actual = parse_openapi()

    missing_in_app = sorted(contract - actual)
    undocumented = sorted(actual - contract - IGNORED)

    # 同一形状但参数名不同：不阻断，但记下来（生成客户端时会踩）
    renames = []
    for method, path in sorted(contract & actual):
        for other_method, other in sorted(actual):
            if other_method != method or _shape(other) != _shape(path):
                continue
            if other != path:
                renames.append((method, path, other))

    print(f"契约声明 {len(contract)} 条，代码实现 {len(actual)} 条")

    if missing_in_app:
        print(f"\n[FAIL] 契约有、代码没有（{len(missing_in_app)} 条）——前端会 404/405：")
        for method, path in missing_in_app:
            print(f"  {method:<6} {path}")

    if renames:
        print(f"\n[WARN] 路径参数名不一致（{len(renames)} 条，端点本身存在）：")
        for method, doc_path, code_path in renames:
            print(f"  {method:<6} 契约 {doc_path}  ←→  代码 {code_path}")

    if undocumented:
        print(f"\n[WARN] 代码有、契约没有（{len(undocumented)} 条）：")
        for method, path in undocumented:
            print(f"  {method:<6} {path}")

    if missing_in_app or (strict and undocumented):
        return 1

    if undocumented:
        print(f"\n阻断项为 0。另有 {len(undocumented)} 条未写入契约（--strict 可转为失败）。")
    else:
        print("\n契约与实现一致。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
