"""老人端配色对比度自检（A-9）。

依据：`docs/plan/2026-11-04-二期完善计划.md` §3.1.2「对比度复核 ≥ WCAG AA」。

只做一件事：把老人端作用域（`.elder-theme`）里实际用到的前景/背景组合，
按 WCAG 2.1 相对亮度公式算对比度，低于阈值即失败退出。

用法：
    python tools/check_elder_contrast.py
"""

from __future__ import annotations

import sys

# WCAG AA：正文 4.5:1，大号文字（≥18.66px 粗体 / ≥24px）3:1
AA_TEXT = 4.5
AA_LARGE = 3.0
AAA_TEXT = 7.0

WHITE = "#ffffff"
BLACK = "#1a1a1a"


def _srgb_to_linear(channel: int) -> float:
    value = channel / 255
    return value / 12.92 if value <= 0.03928 else ((value + 0.055) / 1.055) ** 2.4


def luminance(hex_color: str) -> float:
    raw = hex_color.lstrip("#")
    if len(raw) == 3:
        raw = "".join(ch * 2 for ch in raw)
    r, g, b = (int(raw[i : i + 2], 16) for i in (0, 2, 4))
    return 0.2126 * _srgb_to_linear(r) + 0.7152 * _srgb_to_linear(g) + 0.0722 * _srgb_to_linear(b)


def contrast(fg: str, bg: str) -> float:
    lf, lb = luminance(fg), luminance(bg)
    high, low = (lf, lb) if lf >= lb else (lb, lf)
    return (high + 0.05) / (low + 0.05)


# (名称, 前景, 背景, 需要的阈值)——阈值按该组合的实际字号档取
CASES: list[tuple[str, str, str, float]] = [
    # 主色：正文与按钮
    ("主色文字 / 白底", "#0f766e", WHITE, AA_TEXT),
    ("主色深文字 / 白底", "#115e59", WHITE, AA_TEXT),
    ("白字 / 主色按钮", WHITE, "#0f766e", AA_TEXT),
    ("白字 / 主色深按钮（悬停）", WHITE, "#115e59", AA_TEXT),
    ("深字 / 主色浅底（选中项）", "#0f3d38", "#f0fdfa", AA_TEXT),
    ("主色文字 / 主色浅底", "#0f766e", "#f0fdfa", AA_TEXT),
    # 强调色：仅用于警示类按钮与提示条
    ("白字 / 强调按钮", WHITE, "#c2410c", AA_TEXT),
    ("强调文字 / 白底", "#c2410c", WHITE, AA_TEXT),
    ("深橙字 / 浅橙底（提示条）", "#7c2d12", "#ffedd5", AA_TEXT),
    # 正文三级灰度 / 白底
    ("正文 / 白底", BLACK, WHITE, AAA_TEXT),
    ("次级文字 / 白底", "#475569", WHITE, AA_TEXT),
    ("弱化文字 / 白底", "#64748b", WHITE, AA_TEXT),
    # 页面底色与卡片
    ("正文 / 页面底", BLACK, "#f5f7fa", AA_TEXT),
    ("次级文字 / 页面底", "#475569", "#f5f7fa", AA_TEXT),
]


def main() -> int:
    failures = 0
    print(f"{'组合':<28}{'前景':<10}{'背景':<10}{'比值':>7}{'要求':>7}  判定")
    print("-" * 74)
    for name, fg, bg, need in CASES:
        ratio = contrast(fg, bg)
        ok = ratio >= need
        failures += 0 if ok else 1
        print(
            f"{name:<28}{fg:<10}{bg:<10}{ratio:>7.2f}{need:>7.1f}  {'PASS' if ok else 'FAIL'}"
        )
    print("-" * 74)
    if failures:
        print(f"不通过 {failures} 项：配色不满足 WCAG AA，需调整后再合入。")
        return 1
    print(f"全部 {len(CASES)} 项通过 WCAG AA（正文阈值 {AA_TEXT}:1，弱化文字亦按正文口径要求）。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
