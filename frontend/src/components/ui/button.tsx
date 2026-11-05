// 来源：shadcn/ui (https://github.com/shadcn-ui/ui) · MIT License · 复制自官方 registry
// 适配：颜色改用本项目 `clin.*` token（Slate 中性 + teal 强调），不保留 shadcn 默认 primary 蓝。
import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-clin-sm text-clin-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-clin-accent disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-clin-primary text-white hover:bg-clin-primary-hover",
        destructive: "bg-clin-danger text-white hover:opacity-90",
        outline:
          "border border-clin-border-strong bg-clin-bg text-clin-fg hover:bg-clin-muted",
        secondary: "bg-clin-muted text-clin-fg hover:bg-clin-border",
        ghost: "text-clin-fg-muted hover:bg-clin-muted hover:text-clin-fg",
        link: "text-clin-accent underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-clin-sm px-3 text-clin-xs",
        lg: "h-10 rounded-clin px-6 text-clin",
        icon: "h-8 w-8",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  /** 加载态：显示转圈并禁用按钮（shadcn 原生 API 的补充） */
  loading?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { className, variant, size, asChild = false, loading = false, children, ...props },
    ref,
  ) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        disabled={asChild ? undefined : loading || props.disabled}
        {...props}
      >
        {loading ? (
          <span
            aria-hidden="true"
            className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
          />
        ) : null}
        {children}
      </Comp>
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
