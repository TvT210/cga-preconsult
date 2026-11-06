"""医护端视觉规范自检（对照 docs/frontend/医护端视觉规范.md 的验收项）。

用法：python tools/check_staff_style.py
退出码 0 = 全部通过，1 = 有未通过项。
"""

from __future__ import annotations

import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"
SRC = FRONTEND / "src"

HEX = re.compile(r"#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b")
REQUIRED_UI = [
    "button",
    "card",
    "badge",
    "table",
    "input",
    "label",
    "select",
    "tabs",
    "separator",
    "dropdown-menu",
    "dialog",
    "tooltip",
    "scroll-area",
    "skeleton",
]


SHARED_WITH_ELDER = {
    "AlertCard",
    "AppShell",
    "BigButton",
    "ErrorState",
    "PageHeader",
    "ReportSectionsView",
    "RoleGuard",
    "StatusBadge",
    "Toast",
}

# 老人端独占组件：不参与医护端检查
ELDER_ONLY = {"QuestionCard", "VoiceBar"}


def read(path: pathlib.Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except Exception:
        return ""


def staff_files() -> list[pathlib.Path]:
    """医护端页面 + 医护端专属组件（不含老人端独占组件与两端共享组件）。"""
    pages = [p for p in (SRC / "app" / "staff").rglob("*.tsx")]
    own = [
        p
        for p in (SRC / "components").glob("*.tsx")
        if p.stem not in SHARED_WITH_ELDER and p.stem not in ELDER_ONLY
    ]
    return pages + own


def shared_components() -> list[pathlib.Path]:
    return [
        p
        for p in (SRC / "components").glob("*.tsx")
        if p.stem in SHARED_WITH_ELDER
    ]


def main() -> int:
    failures: list[str] = []
    notes: list[str] = []

    # 1. 医护端不再使用老人端的卡片堆叠样式
    offenders = []
    for path in staff_files():
        text = read(path)
        if "card card-pad" in text:
            offenders.append(str(path.relative_to(ROOT)))
    if offenders:
        failures.append(f"医护端仍在用 .card .card-pad（老人端样式）：{offenders}")
    else:
        notes.append("医护端已无 .card .card-pad 堆叠")

    # 2. 医护端组件不写死颜色（应走 token）
    hex_files = []
    for path in staff_files():
        text = read(path)
        body = "\n".join(
            line for line in text.splitlines() if not line.strip().startswith("//")
        )
        if HEX.search(body):
            hex_files.append(str(path.relative_to(ROOT)))
    if hex_files:
        failures.append(f"医护端组件写死了颜色（应走 clin token）：{hex_files[:8]}")
    else:
        notes.append("医护端组件未写死颜色")

    # 3. shadcn 组件已复制进仓库
    ui_dir = SRC / "components" / "ui"
    missing = [name for name in REQUIRED_UI if not (ui_dir / f"{name}.tsx").exists()]
    if missing:
        failures.append(f"缺少 shadcn 组件：{missing}")
    else:
        notes.append(f"shadcn 组件已就位（{len(REQUIRED_UI)} 个）")

    # 4. cn() 工具函数
    utils = SRC / "lib" / "utils.ts"
    if not utils.exists() or "twMerge" not in read(utils):
        failures.append("缺少 src/lib/utils.ts 的 cn()（clsx + tailwind-merge）")
    else:
        notes.append("cn() 工具函数已就位")

    # 5. 医护端专属主题作用域
    globals_css = read(SRC / "app" / "globals.css")
    if "theme-clinical" not in globals_css:
        failures.append("globals.css 缺少 .theme-clinical 作用域（医护端专属 token）")
    else:
        notes.append(".theme-clinical 主题作用域已定义")

    # 6. 知识库可视化页面
    knowledge = SRC / "app" / "staff" / "knowledge"
    if not knowledge.exists() or not list(knowledge.rglob("page.tsx")):
        failures.append("缺少 /staff/knowledge 知识库可视化页面")
    else:
        notes.append("知识库可视化页面已存在")

    # 7. 图谱库依赖
    # 2026-11-05：2D 视图换型为 cytoscape.js
    # 2026-11-06：主视图追加 3D（react-force-graph-3d），2D 保留为备选视图
    pkg = read(FRONTEND / "package.json")
    if "cytoscape" not in pkg:
        failures.append("package.json 未包含 cytoscape（平面图谱视图）")
    elif "react-force-graph-3d" not in pkg:
        failures.append("package.json 未包含 react-force-graph-3d（3D 图谱主视图）")
    elif "react-force-graph-2d" in pkg:
        failures.append("package.json 仍残留 react-force-graph-2d（2D 版已被 cytoscape 取代）")
    else:
        notes.append("图谱方案：3D 主视图 react-force-graph-3d + 平面备选视图 cytoscape.js")

    # 8. 开源署名
    notice = FRONTEND / "NOTICE.md"
    if not notice.exists():
        failures.append("缺少 frontend/NOTICE.md（shadcn/ui 与图谱库的 MIT 署名）")
    else:
        body = read(notice)
        if "shadcn" not in body.lower():
            failures.append("NOTICE.md 未写明 shadcn/ui 来源与许可证")
        else:
            notes.append("NOTICE.md 署名已就位")

    # 9. 老人端零改动
    result = subprocess.run(
        ["git", "status", "--porcelain", "--", "frontend/src/app/elder", "frontend/src/app/login"],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    changed = [line for line in result.stdout.splitlines() if line.strip()]
    if changed:
        failures.append(f"老人端/登录页被改动（应零变化）：{changed}")
    else:
        notes.append("老人端与登录页零改动")

    # 10. 老人端独占组件零改动
    exclusive = ["frontend/src/components/QuestionCard.tsx", "frontend/src/components/VoiceBar.tsx"]
    result = subprocess.run(
        ["git", "status", "--porcelain", "--"] + exclusive,
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    changed = [line for line in result.stdout.splitlines() if line.strip()]
    if changed:
        failures.append(f"老人端独占组件被改动（应零变化）：{changed}")
    else:
        notes.append("老人端独占组件（QuestionCard/VoiceBar）零改动")

    # 11. 两端共享组件不得写死颜色（必须由作用域给值，否则老人端会被带偏）
    hardcoded = []
    for path in shared_components():
        body = "\n".join(
            line for line in read(path).splitlines() if not line.strip().startswith("//")
        )
        if HEX.search(body):
            hardcoded.append(str(path.relative_to(ROOT)))
    if hardcoded:
        failures.append(
            f"两端共享组件写死了颜色（应由作用域变量给值）：{hardcoded}"
        )
    else:
        notes.append("两端共享组件颜色均由作用域变量控制")

    print("=" * 62)
    print("医护端视觉规范自检")
    print("=" * 62)
    for item in notes:
        print(f"  [OK ] {item}")
    for item in failures:
        print(f"  [FAIL] {item}")
    print("=" * 62)
    print("结论：" + ("全部通过" if not failures else f"{len(failures)} 项未通过"))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
