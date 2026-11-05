import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * 医护端专属 UI 基元（**线 B**：简洁风格）。
 *
 * 依据《医护端视觉规范》：
 * - §2 配色：颜色全部来自 `clin.*` token，本文件不写死任何 hex；
 * - §3 排版：正文 14px / 1.6，页面标题 18px / 600，表格 13px；
 * - §4 布局：内容区 p-6，用 `.clin-section`（1px 上边框 + 14px 半粗标题）
 *   分块，取代老人端的 `.card .card-pad` 堆叠。
 *
 * 这些组件**只服务医护端**，与老人端共用的 `PageHeader` 等组件互不影响。
 */

/** 页面标题栏：标题 18px / 600，说明 13px，右侧操作区 */
export function ClinPageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-4 border-b border-clin-border pb-4">
      <div className="min-w-0">
        <h1 className="text-clin-title font-semibold text-clin-fg">{title}</h1>
        {description ? (
          <p className="mt-1.5 max-w-3xl text-clin-sm text-clin-fg-muted">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/** 区块：1px 上边框 + 14px 半粗标题 + 24px 区块间距 */
export function ClinSection({
  title,
  extra,
  children,
  className,
}: {
  title?: string;
  extra?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("clin-section", className)}>
      {title ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="clin-section-title mb-0">{title}</h2>
          {extra}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/**
 * 顶部关键数字行：数字 + 说明 + 细分隔线，**不带大卡片阴影**。
 * 规范 §4：表格为主，卡片只用于「成组指标」。
 */
export function ClinStatRow({
  items,
}: {
  items: { label: string; value: ReactNode; hint?: string }[];
}) {
  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-clin border border-clin-border bg-clin-border md:grid-cols-4">
      {items.map((item) => (
        <div key={item.label} className="bg-clin-surface px-4 py-3">
          <p className="text-clin-xs text-clin-fg-muted">{item.label}</p>
          <p className="mt-1 text-clin-lg font-semibold tabular-nums text-clin-fg">
            {item.value}
          </p>
          {item.hint ? (
            <p className="mt-0.5 text-clin-xs text-clin-fg-subtle">{item.hint}</p>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/** 医护端加载态（不使用老人端 `.card .card-pad`） */
export function ClinLoading({ label = "正在加载…" }: { label?: string }) {
  return (
    <div
      className="flex items-center justify-center gap-2 py-10 text-clin-sm text-clin-fg-muted"
      role="status"
      aria-live="polite"
    >
      <span
        aria-hidden="true"
        className="h-4 w-4 animate-spin rounded-full border-2 border-clin-accent border-t-transparent"
      />
      {label}
    </div>
  );
}

/** 医护端错误态 */
export function ClinError({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div
      className="rounded-clin border border-clin-danger px-4 py-3 text-clin-sm text-clin-danger"
      role="alert"
    >
      <p>{message}</p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 text-clin-xs font-medium underline underline-offset-2"
        >
          重新加载
        </button>
      ) : null}
    </div>
  );
}

/** 医护端空态 */
export function ClinEmpty({ message }: { message: string }) {
  return (
    <p className="py-8 text-center text-clin-sm text-clin-fg-subtle">{message}</p>
  );
}
