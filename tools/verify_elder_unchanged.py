"""老人端视觉零变化验证：对比改造前后的老人端页面截图。

判定标准（逐像素）：
- 两张图尺寸必须一致；
- 像素差异数必须为 0（完全一致）。

用法：
    python tools/verify_elder_unchanged.py <改造后目录> <改造前基线目录>
"""

from __future__ import annotations

import pathlib
import sys

from PIL import Image, ImageChops

PAGES = ["elder-home", "elder-report"]


def compare(a_path: pathlib.Path, b_path: pathlib.Path) -> tuple[bool, str]:
    if not a_path.exists() or not b_path.exists():
        missing = a_path if not a_path.exists() else b_path
        return False, f"缺少截图：{missing}"

    a = Image.open(a_path).convert("RGB")
    b = Image.open(b_path).convert("RGB")
    if a.size != b.size:
        return False, f"尺寸不同：{a.size} vs {b.size}"

    diff = ImageChops.difference(a, b)
    bbox = diff.getbbox()
    if bbox is None:
        return True, "像素完全一致（差异 0）"

    # 统计差异像素数（放大到阈值以上才算可见变化）
    gray = diff.convert("L")
    hist = gray.histogram()
    changed = sum(hist[16:])
    return False, f"存在差异：bbox={bbox} 显著差异像素 {changed} 个"


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    new_dir = pathlib.Path(sys.argv[1])
    base_dir = pathlib.Path(sys.argv[2])

    all_ok = True
    print(f"改造后目录：{new_dir}")
    print(f"基线目录  ：{base_dir}")
    print("-" * 64)
    for name in PAGES:
        ok, detail = compare(new_dir / f"{name}.png", base_dir / f"{name}.png")
        all_ok = all_ok and ok
        print(f"[{'通过' if ok else '不通过'}] {name}：{detail}")
    print("-" * 64)
    print("结论：老人端视觉" + ("零变化（逐像素一致）" if all_ok else "存在变化，需排查"))
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
