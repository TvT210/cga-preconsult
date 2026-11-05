"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  api,
  fetchMatchScoreSeries,
  fetchQualityMetrics,
  type MatchScorePoint,
  type QualityMetricsResult,
} from "@/lib/api";
import type { AlertItem, Paged } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { QualityMetricCard, type MetricTone } from "@/components/QualityMetricCard";
import { ClinEmpty, ClinError, ClinLoading, ClinSection } from "@/app/staff/_components/clinical";

/**
 * 质控看板（**医护端**）。
 *
 * 规范 §6 图表：继续用 recharts，但去掉渐变、去掉 3D、去掉多余网格线，
 * 只保留一条浅灰横线；数字统一 `tabular-nums`，坐标轴 12px；
 * 图表与表格之间不做卡片包裹，直接放在区块内。
 *
 * 所有颜色走 `clin.*` token（CSS 变量），本文件不写死 hex。
 */

/** 图表用的语义色（取自 `clin` token 的 CSS 变量） */
const CHART_COLOR = {
  accent: "var(--c-accent)",
  danger: "var(--c-danger)",
  warning: "var(--c-warning)",
  success: "var(--c-success)",
  border: "var(--c-border)",
  fgMuted: "var(--c-fg-muted)",
  fgSubtle: "var(--c-fg-subtle)",
};

/** 提醒等级配色 */
const ALERT_LEVEL_COLOR: Record<string, string> = {
  immediate: CHART_COLOR.danger,
  urgent: CHART_COLOR.warning,
  elective: CHART_COLOR.accent,
  observe: CHART_COLOR.success,
};

const ALERT_LEVEL_TEXT: Record<string, string> = {
  immediate: "立即就医",
  urgent: "尽快就医",
  elective: "择期就诊",
  observe: "居家观察",
};

interface MetricDef {
  key: string;
  label: string;
  format: "percent" | "number" | "score";
  meaning: string;
  tone?: MetricTone;
  /** 降级模式下该指标不可得时的说明 */
  unavailableText?: string;
  /** 管理员接口也没有数据时的说明 */
  emptyText?: string;
}

const METRICS: MetricDef[] = [
  {
    key: "assessment_completion_rate",
    label: "评估完成率",
    format: "percent",
    meaning: "已完成或已复核的评估占全部评估的比例，反映评估流程推进效率。",
  },
  {
    key: "review_rate",
    label: "复核率",
    format: "percent",
    meaning: "已复核评估占已判读评估的比例，越高说明结论越经得起人工确认。",
  },
  {
    key: "abnormal_detection_rate",
    label: "异常检出率",
    format: "percent",
    meaning: "被判为异常的评估占比；明显偏高通常提示量表阈值偏松，需复核。",
  },
  {
    key: "pending_confirmation_rate",
    label: "待确认率",
    format: "percent",
    meaning: "缺项或仍待人工确认的评估占比，需及时安排医护补齐信息。",
  },
  {
    key: "alert_response_rate",
    label: "提醒响应率",
    format: "percent",
    meaning: "已被处理（已知悉／升级／关闭）的提醒占比，反映闭环情况。",
  },
  {
    key: "high_level_alert_ratio",
    label: "高等级提醒占比",
    format: "percent",
    meaning: "「立即就医」与「尽快就医」的提醒占比，占比过高需复核触发规则。",
  },
  {
    key: "false_alert_rate",
    label: "误报率",
    format: "percent",
    meaning: "被标记为误报的高等级提醒占比，由医护「标记误报」持续喂养，越低越好。",
    tone: "bad",
    unavailableText: "需管理员权限",
    emptyText: "尚未标记过误报",
  },
  {
    key: "scoring_consistency",
    label: "计分一致率",
    format: "percent",
    meaning: "复核中未发生改分的样本占比；越低说明机器计分与人工判断差异越大。",
    unavailableText: "需管理员权限",
    emptyText: "尚无复核改分样本",
  },
  {
    key: "ai_review_coverage",
    label: "AI 复核覆盖率",
    format: "percent",
    meaning: "做过 AI 语义复核的匹配批次占全部批次的比例，越高说明人工参考面越广。",
  },
  {
    key: "disease_library_coverage",
    label: "疾病库覆盖率",
    format: "percent",
    meaning: "历史匹配实际命中的病种数占疾病库总量的比例，覆盖越广说明库越有效。",
  },
  {
    key: "top1_match_score_avg",
    label: "Top1 匹配度均值",
    format: "score",
    meaning: "各批次最高匹配候选的平均匹配度，整体反映规则引擎的匹配强度。",
  },
  {
    key: "top1_top2_gap_avg",
    label: "Top1-Top2 平均差值",
    format: "score",
    meaning: "差值越小 = 越难区分的难例，需要更多追问或人工复核。",
    tone: "warn",
  },
];

/** 判断指标是否因权限受限而不可得 */
function isUnavailable(result: QualityMetricsResult, key: string): boolean {
  return result.unavailable.includes(key);
}

export function QualityDashboard() {
  const [result, setResult] = useState<QualityMetricsResult | null>(null);
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [series, setSeries] = useState<MatchScorePoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const metricsResult = await fetchQualityMetrics();
      setResult(metricsResult);

      // 提醒分级分布与 Top1 趋势需单独取（管理员指标接口不含明细）
      const [alertResult, seriesResult] = await Promise.allSettled([
        api.get<AlertItem[] | Paged<AlertItem>>("/alerts"),
        fetchMatchScoreSeries(20),
      ]);
      setAlerts(
        alertResult.status === "fulfilled"
          ? Array.isArray(alertResult.value)
            ? alertResult.value
            : (alertResult.value?.items ?? [])
          : [],
      );
      setSeries(seriesResult.status === "fulfilled" ? seriesResult.value : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "暂时无法获取质控指标。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** 柱状图数据：各量表评估数与异常数 */
  const scaleChartData = useMemo(() => {
    const stats = result?.metrics.scale_stats ?? {};
    return Object.entries(stats).map(([code, bucket]) => ({
      scaleCode: code,
      total: bucket.total ?? 0,
      abnormal: bucket.abnormal ?? 0,
      pending: bucket.pending ?? 0,
    }));
  }, [result]);

  /** 折线图数据：逐批次的 Top1 匹配度与 Top1-Top2 差值 */
  const trendChartData = useMemo(
    () =>
      series.map((point) => ({
        name: `批次 ${point.runId}`,
        top1: point.top1,
        gap: point.gap,
      })),
    [series],
  );

  /** 环形图数据：提醒分级分布 */
  const alertChartData = useMemo(() => {
    const counts = new Map<string, number>();
    alerts.forEach((alert) => {
      const level = alert.level || "observe";
      counts.set(level, (counts.get(level) ?? 0) + 1);
    });
    return Array.from(counts.entries()).map(([level, value]) => ({
      level,
      name: ALERT_LEVEL_TEXT[level] ?? level,
      value,
    }));
  }, [alerts]);

  if (loading && !result) {
    return <ClinLoading label="正在加载质控指标…" />;
  }

  if (error) {
    return <ClinError message={error} onRetry={() => void load()} />;
  }

  if (!result) {
    return <ClinEmpty message="暂无质控数据。" />;
  }

  const metrics = result.metrics;

  return (
    <div>
      {result.degraded ? (
        <div className="mb-6 rounded-clin border border-clin-warning px-4 py-3">
          <p className="text-clin-sm font-medium text-clin-fg">部分指标需管理员权限</p>
          <p className="mt-1 text-clin-xs text-clin-fg-muted">
            {result.degradedNote ??
              "当前账号无质控接口权限，以下指标由公开接口自行聚合。"}
          </p>
        </div>
      ) : null}

      {/* ---------------------------- 指标区 ---------------------------- */}
      {/* 两列密排的指标行，不用大卡片 */}
      <ClinSection title="核心指标">
        <div className="grid gap-x-8 md:grid-cols-2">
          {METRICS.map((def) => {
            const raw = (metrics as unknown as Record<string, number | null | undefined>)[
              def.key
            ];
            const value = typeof raw === "number" ? raw : null;
            const blocked = isUnavailable(result, def.key);
            return (
              <QualityMetricCard
                key={def.key}
                label={def.label}
                value={blocked ? null : value}
                format={def.format}
                meaning={def.meaning}
                tone={def.tone}
                unavailableText={blocked ? def.unavailableText : def.emptyText}
              />
            );
          })}
        </div>
        {metrics.note ? (
          <p className="mt-3 text-clin-xs text-clin-fg-subtle">{metrics.note}</p>
        ) : null}
      </ClinSection>

      {/* ---------------------------- 图表区 ---------------------------- */}
      <ClinSection title="量表分布与匹配趋势">
        <div className="grid gap-6 lg:grid-cols-2">
          <div>
            <h3 className="text-clin-sm font-medium text-clin-fg">
              各量表评估数与异常数
            </h3>
            <p className="mt-1 text-clin-xs text-clin-fg-muted">
              数据来源：各量表判读结果；异常数持续偏高需复核该量表阈值。
            </p>
            <div className="mt-3 h-[260px] w-full">
              {scaleChartData.length === 0 ? (
                <ClinEmpty message="暂无量表评估数据。" />
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={scaleChartData}>
                    {/* 只保留一条浅灰横线（规范 §6） */}
                    <CartesianGrid vertical={false} stroke={CHART_COLOR.border} />
                    <XAxis
                      dataKey="scaleCode"
                      stroke={CHART_COLOR.fgMuted}
                      fontSize={12}
                      tickLine={false}
                    />
                    <YAxis
                      stroke={CHART_COLOR.fgMuted}
                      fontSize={12}
                      tickLine={false}
                      axisLine={false}
                      allowDecimals={false}
                    />
                    <Tooltip
                      contentStyle={{
                        fontSize: 12,
                        borderRadius: 6,
                        border: `1px solid ${CHART_COLOR.border}`,
                        boxShadow: "none",
                      }}
                    />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar
                      dataKey="total"
                      name="评估数"
                      fill={CHART_COLOR.accent}
                      radius={[2, 2, 0, 0]}
                    />
                    <Bar
                      dataKey="abnormal"
                      name="异常数"
                      fill={CHART_COLOR.danger}
                      radius={[2, 2, 0, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          <div>
            <h3 className="text-clin-sm font-medium text-clin-fg">
              Top1 匹配度与 Top1-Top2 差值
            </h3>
            <p className="mt-1 text-clin-xs text-clin-fg-muted">
              差值越小表示 Top1 与 Top2 越难区分，属于需要人工复核的难例。
            </p>
            <div className="mt-3 h-[260px] w-full">
              {trendChartData.length === 0 ? (
                <ClinEmpty message="暂无匹配批次数据。" />
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={trendChartData}>
                    <CartesianGrid vertical={false} stroke={CHART_COLOR.border} />
                    <XAxis
                      dataKey="name"
                      stroke={CHART_COLOR.fgMuted}
                      fontSize={12}
                      tickLine={false}
                    />
                    <YAxis
                      yAxisId="left"
                      stroke={CHART_COLOR.fgMuted}
                      fontSize={12}
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis
                      yAxisId="right"
                      orientation="right"
                      stroke={CHART_COLOR.warning}
                      fontSize={12}
                      tickLine={false}
                      axisLine={false}
                    />
                    <Tooltip
                      contentStyle={{
                        fontSize: 12,
                        borderRadius: 6,
                        border: `1px solid ${CHART_COLOR.border}`,
                        boxShadow: "none",
                      }}
                    />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Line
                      yAxisId="left"
                      type="monotone"
                      dataKey="top1"
                      name="Top1 匹配度"
                      stroke={CHART_COLOR.accent}
                      strokeWidth={2}
                      dot={{ r: 2 }}
                    />
                    <Line
                      yAxisId="right"
                      type="monotone"
                      dataKey="gap"
                      name="Top1-Top2 差值"
                      stroke={CHART_COLOR.warning}
                      strokeWidth={2}
                      strokeDasharray="5 3"
                      dot={{ r: 2 }}
                      connectNulls
                    />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          <div>
            <h3 className="text-clin-sm font-medium text-clin-fg">提醒分级分布</h3>
            <p className="mt-1 text-clin-xs text-clin-fg-muted">
              高等级（立即就医／尽快就医）提醒占比过高时，需回看触发规则与误报情况。
            </p>
            <div className="mt-3 h-[260px] w-full">
              {alertChartData.length === 0 ? (
                <ClinEmpty message="暂无就医提醒数据。" />
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Tooltip
                      contentStyle={{
                        fontSize: 12,
                        borderRadius: 6,
                        border: `1px solid ${CHART_COLOR.border}`,
                        boxShadow: "none",
                      }}
                    />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Pie
                      data={alertChartData}
                      dataKey="value"
                      nameKey="name"
                      innerRadius="55%"
                      outerRadius="80%"
                      paddingAngle={2}
                      stroke="none"
                    >
                      {alertChartData.map((entry) => (
                        <Cell
                          key={entry.level}
                          fill={ALERT_LEVEL_COLOR[entry.level] ?? CHART_COLOR.fgSubtle}
                        />
                      ))}
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          <div>
            <h3 className="text-clin-sm font-medium text-clin-fg">工作量概览</h3>
            <p className="mt-1 text-clin-xs text-clin-fg-muted">
              来自系统统计接口的总量数据，用于判断质控指标的分母规模。
            </p>
            <dl className="mt-3 divide-y divide-clin-border border-y border-clin-border">
              {Object.entries(metrics.stats ?? {})
                .filter(([key]) => key !== "generated_at")
                .map(([key, value]) => (
                  <div key={key} className="flex items-baseline justify-between py-1.5">
                    <dt className="text-clin-xs text-clin-fg-muted">
                      {STAT_LABELS[key] ?? key}
                    </dt>
                    <dd className="text-clin-sm font-medium tabular-nums text-clin-fg">
                      {typeof value === "number" ? value : "—"}
                    </dd>
                  </div>
                ))}
            </dl>
            <div className="mt-3">
              <Button variant="outline" size="sm" onClick={() => void load()}>
                刷新质控数据
              </Button>
            </div>
            {metrics.generated_at ? (
              <p className="mt-2 text-clin-xs text-clin-fg-subtle">
                指标生成时间：{metrics.generated_at}
              </p>
            ) : null}
          </div>
        </div>
      </ClinSection>
    </div>
  );
}

/** 统计字段中文名 */
const STAT_LABELS: Record<string, string> = {
  patients: "患者数",
  users: "账号数",
  assessments: "评估数",
  abnormal_assessments: "异常评估",
  reports: "报告数",
  match_runs: "匹配批次",
  alerts: "提醒数",
  pending_review: "待复核",
  ai_reviews: "AI 复核数",
};
