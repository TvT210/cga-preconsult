// 来源：shadcn/ui (https://github.com/shadcn-ui/ui) · MIT License · 复制自官方 registry
// 适配：加载态占位，底色为 `clin-muted`（不使用 primary 蓝）。
import { cn } from "@/lib/utils";

function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("animate-pulse rounded-clin-sm bg-clin-muted", className)}
      {...props}
    />
  );
}

export { Skeleton };
