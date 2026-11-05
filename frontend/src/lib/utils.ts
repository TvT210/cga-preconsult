import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * 合并 className：clsx 处理条件类名，tailwind-merge 解决 Tailwind 类冲突。
 * 来源：shadcn/ui (https://github.com/shadcn-ui/ui) · MIT License
 *
 * 【为什么必须 extendTailwindMerge】
 * 本项目自定义了 `text-clin-*`（医护端字号）与 `text-elder-*`（适老化字号），
 * Tailwind 中 `text-` 前缀同时覆盖「字号」和「文字颜色」两类工具类。
 * tailwind-merge 只认识 Tailwind 内置字号刻度（xs/sm/base/lg…），
 * 会把未知的 `text-clin-xs` 判成**文字颜色**类，于是：
 *   1. `cn("text-clin-sm", "text-clin-fg-muted")` → 字号被当成颜色冲突掉；
 *   2. `cn("text-white", "text-clin-xs")` → `text-white` 被吞，
 *      白字退回继承色，在深色按钮上直接「消失」。
 * 因此这里显式声明本项目的自定义字号属于 font-size 组，
 * 让 `text-clin-*` / `text-elder-*` 与 `text-white`、`text-clin-fg-*` 各归各位。
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      /** 自定义字号（clin-*：医护端；elder-*：老人端），均非文字颜色 */
      "font-size": [
        {
          text: [
            // 医护端字号阶梯（tailwind.config.ts: fontSize）
            "clin",
            "clin-xs",
            "clin-sm",
            "clin-lg",
            "clin-title",
            // 老人端字号阶梯（尾行仅登记类名，不改动老人端任何样式）
            "elder",
            "elder-lg",
            "elder-xl",
            "elder-2xl",
          ],
        },
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
