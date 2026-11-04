"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useCurrentUser } from "@/lib/useCurrentUser";
import {
  assessmentStatusLabel,
  formatDateTime,
  reviewStatusLabel,
} from "@/lib/format";
import type {
  AlertItem,
  AssessmentListItem,
  Paged,
  ReportListItem,
  ScaleListItem,
} from "@/lib/types";
import { AlertCard } from "@/components/AlertCard";
import { BigButton } from "@/components/BigButton";
import { EmptyState, ErrorState, LoadingState } from "@/components/ErrorState";
import { PageHeader, SectionTitle } from "@/components/PageHeader";
import { StatusBadge } from "@/components/StatusBadge";

/** 兼容后端返回数组或 {items,total,page,size} 两种列表结构 */
function toItems<T>(payload: T[] | Paged<T> | null | undefined): T[] {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  return payload.items ?? [];
}

export default function ElderHomePage() {
  const { user } = useCurrentUser();
  // patient_id 保持后端原样（整数主键）：查询参数由 api 层转字符串，请求体按原类型发送
  const patientId = user?.patient_id ?? null;

  const [scales, setScales] = useState<ScaleListItem[]>([]);
  const [assessments, setAssessments] = useState<AssessmentListItem[]>([]);
  const [reports, setReports] = useState<ReportListItem[]>([]);
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (patientId === null || patientId === "") {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const [scalePayload, assessmentPayload, reportPayload, alertPayload] =
        await Promise.all([
          api.get<ScaleListItem[] | Paged<ScaleListItem>>("/scales"),
          api.get<AssessmentListItem[] | Paged<AssessmentListItem>>("/assessments", {
            patient_id: patientId,
          }),
          api.get<ReportListItem[] | Paged<ReportListItem>>("/reports", {
            patient_id: patientId,
          }),
          api.get<AlertItem[] | Paged<AlertItem>>("/alerts", {
            patient_id: patientId,
          }),
        ]);
      setScales(toItems(scalePayload));
      setAssessments(toItems(assessmentPayload));
      setReports(toItems(reportPayload));
      setAlerts(toItems(alertPayload));
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "暂时无法获取数据，请稍后重试或联系工作人员。",
      );
    } finally {
      setLoading(false);
    }
  }, [patientId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 某量表是否存在进行中的会话（用于「继续上次进度」） */
  const ongoingOf = (scaleCode: string) =>
    assessments.find(
      (item) => item.scale_code === scaleCode && item.status === "in_progress",
    );

  if (loading) {
    return (
      <div className="space-y-5">
        <LoadingState label="正在准备您的首页…" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title={`您好，${user?.full_name || "老人"}`}
        description="这里可以开始新的健康评估、查看评估报告，以及接收就医提醒。遇到看不懂的地方，可以随时联系工作人员。"
      />

      {error ? <ErrorState message={error} onRetry={() => void load()} /> : null}

      {/* 待评估任务 */}
      <section>
        <SectionTitle title="待评估任务" />
        {scales.length === 0 ? (
          <EmptyState message="暂无可评估的量表，请联系工作人员安排。" />
        ) : (
          <ul className="grid gap-4 md:grid-cols-2">
            {scales.map((scale) => {
              const ongoing = ongoingOf(scale.code);
              return (
                <li key={scale.code} className="card card-pad flex flex-col gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-elder-lg font-semibold text-ink">
                      {scale.name}
                    </h3>
                    {scale.review_status !== "approved" ? (
                      <StatusBadge
                        label={reviewStatusLabel(scale.review_status)}
                        tone="amber"
                      />
                    ) : (
                      <StatusBadge label="已评审" tone="green" />
                    )}
                  </div>
                  <p className="text-elder text-ink-soft">
                    所属维度：{scale.dimension} · 采集方式：{scale.method} · 共{" "}
                    {scale.item_count} 题
                  </p>
                  <Link href={`/elder/scale/${encodeURIComponent(scale.code)}`}>
                    <BigButton size="lg" fullWidth>
                      {ongoing ? "继续上次进度" : "开始评估"}
                    </BigButton>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* 评估记录 */}
      <section>
        <SectionTitle title="我的评估记录" />
        {assessments.length === 0 ? (
          <EmptyState message="还没有评估记录，点击上面的任务开始第一次评估。" />
        ) : (
          <ul className="space-y-3">
            {assessments.map((item) => (
              <li
                key={String(item.id)}
                className="card card-pad flex flex-wrap items-center justify-between gap-3"
              >
                <div>
                  <p className="text-elder-lg font-semibold text-ink">
                    {item.scale_name || item.scale_code}
                  </p>
                  <p className="mt-1 text-elder text-ink-soft">
                    状态：{assessmentStatusLabel(item.status)} · 时间：
                    {formatDateTime(item.finished_at ?? item.started_at ?? item.created_at)}
                  </p>
                </div>
                {item.status === "in_progress" ? (
                  <Link
                    href={`/elder/scale/${encodeURIComponent(item.scale_code)}`}
                  >
                    <BigButton variant="secondary" size="lg">
                      继续填写
                    </BigButton>
                  </Link>
                ) : (
                  <Link href="/elder/report">
                    <BigButton variant="ghost" size="lg">
                      查看报告
                    </BigButton>
                  </Link>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 报告入口 */}
      <section>
        <SectionTitle title="我的报告" />
        {reports.length === 0 ? (
          <EmptyState message="暂无可查看的报告，完成评估后由工作人员生成。" />
        ) : (
          <ul className="space-y-3">
            {reports.map((report) => (
              <li
                key={String(report.id)}
                className="card card-pad flex flex-wrap items-center justify-between gap-3"
              >
                <div>
                  <p className="text-elder-lg font-semibold text-ink">
                    {report.title || "老年综合评估报告"}
                    {report.version ? `（第 ${report.version} 版）` : ""}
                  </p>
                  <p className="mt-1 text-elder text-ink-soft">
                    生成时间：{formatDateTime(report.created_at)}
                  </p>
                </div>
                <Link href="/elder/report">
                  <BigButton variant="secondary" size="lg">
                    查看详情
                  </BigButton>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 就医提醒 */}
      <section>
        <SectionTitle title="就医提醒" />
        {alerts.length === 0 ? (
          <EmptyState message="目前没有需要立即处理的提醒。" />
        ) : (
          <ul className="space-y-4">
            {alerts.map((alert) => (
              <li key={String(alert.id)}>
                <AlertCard alert={alert} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
