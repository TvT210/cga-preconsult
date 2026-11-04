import type { ReactNode } from "react";

/** 页面标题栏 */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-elder-2xl font-bold text-ink">{title}</h1>
        {description ? (
          <p className="mt-2 max-w-3xl text-elder text-ink-soft">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-3">{actions}</div> : null}
    </header>
  );
}

/** 小节标题 */
export function SectionTitle({
  title,
  extra,
}: {
  title: string;
  extra?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <h2 className="section-title">{title}</h2>
      {extra}
    </div>
  );
}
