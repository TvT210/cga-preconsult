"use client";

/**
 * 质控指标行（**医护端**）。
 *
 * 关键约束：`null` 表示「暂无数据」（需标注集 / 需管理员权限），**不得**渲染成 0。
 *
 * 规范 §3：数字 24px + `tabular-nums`，说明 11~12px；
 * 与《大卡片》不同，这里是**两列密排的指标行**，不占大面积。
 */

export type MetricTone = "default" | "good" | "warn" | "bad";

const TONE_CLASS: Record<MetricTone, string> = {
  default: "text-clin-fg",
  good: "text-clin-success",
  warn: "text-clin-warning",
  bad: "text-clin-danger",
};

export interface QualityMetricCardProps {
  /** 指标名 */
  label: string;
  /** 指标值；null / undefined 表示暂无数据 */
  value: number | null | undefined;
  /** 数值展示格式 */
  format?: "percent" | "number" | "score";
  /** 指标含义 / 趋势解读 */
  meaning?: string;
  /** 暂无数据的原因，例如「需标注集」「需管理员权限」 */
  unavailableText?: string;
  /** 附加说明，例如样本量 */
  footnote?: string;
  tone?: MetricTone;
}

function formatValue(
  value: number,
  format: "percent" | "number" | "score",
): string {
  if (format === "percent") {
    return `${(value * 100).toFixed(1)}%`;
  }
  if (format === "score") {
    return value.toFixed(2);
  }
  return String(value);
}

export function QualityMetricCard({
  label,
  value,
  format = "percent",
  meaning,
  unavailableText,
  footnote,
  tone = "default",
}: QualityMetricCardProps) {
  const hasValue = typeof value === "number" && Number.isFinite(value);

  return (
    <div className="border-b border-clin-border py-2.5 last:border-b-0">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-clin-xs text-clin-fg-muted">{label}</p>
        {hasValue ? (
          <p className={`text-[24px] font-semibold leading-none tabular-nums ${TONE_CLASS[tone]}`}>
            {formatValue(value, format)}
          </p>
        ) : (
          <p className="text-clin-sm font-medium leading-none text-clin-fg-subtle">
            暂无数据
          </p>
        )}
      </div>
      {hasValue ? (
        <>
          {footnote ? (
            <p className="mt-1 text-clin-xs text-clin-fg-subtle">{footnote}</p>
          ) : null}
          {meaning ? (
            <p className="mt-0.5 text-clin-xs leading-relaxed text-clin-fg-muted">
              {meaning}
            </p>
          ) : null}
        </>
      ) : (
        <p className="mt-1 text-clin-xs text-clin-fg-subtle">
          {unavailableText ?? "暂无数据"}
        </p>
      )}
    </div>
  );
}
