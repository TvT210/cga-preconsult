// 来源：shadcn/ui (https://github.com/shadcn-ui/ui) · MIT License · 复制自官方 registry
// 适配：状态徽章（风险等级 / 复核状态 / 量表维度），语义色只用于徽章（规范 §2 规则 3）。
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-clin-sm border px-2 py-0.5 text-clin-xs font-medium leading-5 transition-colors focus:outline-none focus:ring-1 focus:ring-clin-accent",
  {
    variants: {
      variant: {
        default: "border-transparent bg-clin-primary text-white",
        secondary: "border-clin-border bg-clin-muted text-clin-fg-muted",
        destructive: "border-transparent bg-clin-danger text-white",
        success: "border-transparent bg-clin-success text-white",
        warning: "border-transparent bg-clin-warning text-white",
        accent: "border-transparent bg-clin-accent-soft text-clin-accent",
        outline: "border-clin-border-strong bg-clin-bg text-clin-fg",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
