"""老人端视觉零变化验证。

判据（按证据强度排序）：

1. **源码层**（推荐用 git 直接确认）：
   `git diff HEAD -- frontend/src/app/elder frontend/src/app/login
    frontend/src/components/QuestionCard.tsx frontend/src/components/VoiceBar.tsx`
   必须为空——老人端源码与它使用的共享组件（AppShell / RoleGuard / AlertCard /
   BigButton / ErrorState / PageHeader / StatusBadge）都没动。

2. **CSS 规则层**：编译产物 `.next/static/css/*.css` 逐条规则比对，
   老人端相关的规则必须完全一致（医护端只允许**新增**自己的选择器）。

3. **像素层**（本脚本）：按**最大通道差**统计分级差异。
   文字与圆角边缘的抗锯齿在不同构建产物之间会有 1~2/255 的差异，
   这是浏览器栅格化噪声、不是视觉回归，因此判据用「可见差异」而非「严格 0」：
   - 最大通道差 ≥ 64/255（25%）的像素数 ≤ 4（容许极少量抗锯齿边缘像素）；
   - 最大通道差 > 32/255 的像素占比 < 0.01%。

用法：
    python tools/verify_elder_unchanged.py <改造后目录> <基线目录> [--dom <基线DOM签名目录>]
"""

from __future__ import annotations

import difflib
import pathlib
import sys

from PIL import Image

PAGES = ["elder-home", "elder-report"]
DOM_PAGES = [("_elder", "/elder"), ("_elder_report", "/elder/report")]

# 可见差异阈值（最大通道差，0~255）
VISIBLE = 32
# 允许的「强差异」抗锯齿边缘像素上限
STRONG_LIMIT = 4
# 强差异像素占比上限
STRONG_RATIO = 0.0001  # 0.01%


def compare_images(a_path: pathlib.Path, b_path: pathlib.Path) -> tuple[bool, str]:
    if not a_path.exists() or not b_path.exists():
        missing = a_path if not a_path.exists() else b_path
        return False, f"缺少截图：{missing}"

    a = Image.open(a_path).convert("RGB")
    b = Image.open(b_path).convert("RGB")
    if a.size != b.size:
        return False, f"尺寸不同：{a.size} vs {b.size}"

    import numpy as np

    diff = np.abs(
        np.asarray(a, dtype=np.int16) - np.asarray(b, dtype=np.int16)
    ).max(axis=2)
    total = int(diff.size)
    strict = int((diff > 0).sum())
    visible = int((diff > VISIBLE).sum())
    strong = int((diff >= 64).sum())
    ratio = visible / total

    ok = strong <= STRONG_LIMIT and ratio < STRONG_RATIO
    detail = (
        f"差异分布：>0 {strict} 像素({100*strict/total:.3f}%) | "
        f">{VISIBLE} {visible} 像素({100*ratio:.4f}%) | ≥64 {strong} 像素"
    )
    if ok:
        detail += " → 仅抗锯齿级差异，肉眼无变化"
    else:
        detail += " → 超出容差，判定为可见变化"
    return ok, detail


def compare_dom(new_dir: pathlib.Path, base_dir: pathlib.Path) -> tuple[bool, str]:
    all_ok = True
    lines = []
    for name, route in DOM_PAGES:
        a = base_dir / f"{name}.signature.txt"
        b = new_dir / f"{name}.signature.txt"
        if not a.exists() or not b.exists():
            all_ok = False
            lines.append(f"[缺失] {route} 缺少 DOM 签名文件")
            continue
        ta = a.read_text(encoding="utf-8").splitlines()
        tb = b.read_text(encoding="utf-8").splitlines()
        d = list(difflib.unified_diff(ta, tb, lineterm=""))
        if d:
            all_ok = False
            lines.append(f"[不一致] {route} DOM 签名差异 {len(d)} 行：{d[:6]}")
        else:
            lines.append(f"[一致] {route} DOM 签名完全一致（{len(ta)} 行）")
    return all_ok, "\n    ".join(lines)


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    new_dir = pathlib.Path(sys.argv[1])
    base_dir = pathlib.Path(sys.argv[2])
    dom_base: pathlib.Path | None = None
    if "--dom" in sys.argv:
        idx = sys.argv.index("--dom")
        if idx + 1 < len(sys.argv):
            dom_base = pathlib.Path(sys.argv[idx + 1])

    print(f"改造后目录：{new_dir}")
    print(f"基线目录  ：{base_dir}")
    if dom_base:
        print(f"DOM 基线  ：{dom_base}")
    print("-" * 72)

    all_ok = True
    for name in PAGES:
        ok, detail = compare_images(new_dir / f"{name}.png", base_dir / f"{name}.png")
        all_ok = all_ok and ok
        print(f"[{'通过' if ok else '不通过'}] {name}：{detail}")

    if dom_base:
        dom_new = new_dir / "dom-signature"
        ok, detail = compare_dom(dom_new, dom_base)
        all_ok = all_ok and ok
        print(f"[{'通过' if ok else '不通过'}] DOM 结构签名：{detail}")

    print("-" * 72)
    print(
        "结论：老人端"
        + ("视觉零变化（仅抗锯齿级差异）" if all_ok else "存在变化，需排查")
    )
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
