// 来源：shadcn/ui (https://github.com/shadcn-ui/ui) · MIT License · 复制自官方 registry
// 适配：搜索 / 筛选输入框，高度 32px（规范 §5），非适老化的 48px。
import * as React from "react";

import { cn } from "@/lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-8 w-full rounded-clin-sm border border-clin-border-strong bg-clin-bg px-3 py-1 text-clin-sm text-clin-fg transition-colors placeholder:text-clin-fg-subtle focus-visible:border-clin-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-clin-accent disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };
