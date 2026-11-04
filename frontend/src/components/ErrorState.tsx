"use client";

import { BigButton } from "./BigButton";

/** 接口失败时的友好错误态，避免白屏 */
export function ErrorState({
  message,
  onRetry,
  className = "",
}: {
  message: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div
      className={`card card-pad flex flex-col items-center gap-4 text-center ${className}`}
      role="alert"
    >
      <div
        aria-hidden="true"
        className="flex h-14 w-14 items-center justify-center rounded-full bg-amber-100 text-amber-700"
      >
        <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth={2}>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"
          />
        </svg>
      </div>
      <div>
        <p className="text-elder-lg font-semibold text-ink">暂时无法显示内容</p>
        <p className="mt-2 text-elder text-ink-soft">{message}</p>
      </div>
      {onRetry ? (
        <BigButton variant="secondary" onClick={onRetry}>
          重新加载
        </BigButton>
      ) : null}
    </div>
  );
}

/** 加载占位 */
export function LoadingState({ label = "正在加载，请稍候…" }: { label?: string }) {
  return (
    <div
      className="card card-pad flex items-center justify-center gap-3 text-elder text-ink-soft"
      role="status"
      aria-live="polite"
    >
      <span
        aria-hidden="true"
        className="h-6 w-6 animate-spin rounded-full border-2 border-medical-700 border-t-transparent"
      />
      {label}
    </div>
  );
}

/** 空数据提示 */
export function EmptyState({ message }: { message: string }) {
  return (
    <div className="card card-pad text-center text-elder text-ink-mute">{message}</div>
  );
}
