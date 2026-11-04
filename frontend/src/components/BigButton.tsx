"use client";

import { forwardRef } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "success" | "warning";
type Size = "md" | "lg" | "xl";

export interface BigButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  fullWidth?: boolean;
  loading?: boolean;
}

const VARIANT_CLASS: Record<Variant, string> = {
  primary: "bg-medical-700 text-white hover:bg-medical-800 active:bg-medical-900",
  secondary:
    "bg-white text-medical-700 border-2 border-medical-700 hover:bg-medical-50",
  ghost: "bg-transparent text-ink-soft hover:bg-slate-100",
  danger: "bg-red-700 text-white hover:bg-red-800",
  success: "bg-emerald-700 text-white hover:bg-emerald-800",
  warning: "bg-amber-600 text-white hover:bg-amber-700",
};

const SIZE_CLASS: Record<Size, string> = {
  // 适老化：最小点击高度 48px
  md: "min-h-btn px-5 py-3 text-elder",
  lg: "min-h-btn-lg px-6 py-3.5 text-elder-lg",
  xl: "min-h-[64px] px-7 py-4 text-elder-xl",
};

/**
 * 适老化大按钮：最小高度 48px，字号不低于 18px。
 */
export const BigButton = forwardRef<HTMLButtonElement, BigButtonProps>(
  function BigButton(
    {
      variant = "primary",
      size = "md",
      fullWidth = false,
      loading = false,
      disabled,
      className = "",
      children,
      type = "button",
      ...rest
    },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type={type}
        disabled={disabled || loading}
        className={[
          "inline-flex items-center justify-center gap-2 rounded-xl font-semibold",
          "transition-colors duration-150",
          "disabled:cursor-not-allowed disabled:opacity-50",
          VARIANT_CLASS[variant],
          SIZE_CLASS[size],
          fullWidth ? "w-full" : "",
          className,
        ].join(" ")}
        {...rest}
      >
        {loading ? (
          <span
            aria-hidden="true"
            className="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent"
          />
        ) : null}
        {children}
      </button>
    );
  },
);
