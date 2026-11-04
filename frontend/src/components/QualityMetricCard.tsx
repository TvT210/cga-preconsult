"use client";

/**
 * 质控指标卡。
 * 关键约束：`null` 表示「暂无数据」（需标注集 / 需管理员权限），**不得**渲染成 0。
 */

export type MetricTone = "default" | "good" | "warn" | "bad";

const TONE_CLASS: Record<MetricTone, string> = {
  default: "text-medical-900",
  good: "text-emerald-700",
  warn: "text-amber-700",
  bad: "text-red-700",
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
    <div className="card card-pad flex flex-col">
      <p className="text-elder text-ink-soft">{label}</p>
      {hasValue ? (
        <>
          <p className={`mt-1 text-elder-2xl font-bold ${TONE_CLASS[tone]}`}>
            {formatValue(value, format)}
          </p>
          {footnote ? (
            <p className="mt-1 text-sm text-ink-mute">{footnote}</p>
          ) : null}
        </>
      ) : (
        <>
          <p className="mt-1 text-elder-lg font-bold text-ink-mute">暂无数据</p>
          <p className="mt-1 text-sm text-ink-mute">
            {unavailableText ?? "暂无数据"}
          </p>
        </>
      )}
      {meaning ? (
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">{meaning}</p>
      ) : null}
    </div>
  );
}
