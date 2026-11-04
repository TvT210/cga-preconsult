"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useCurrentUser } from "@/lib/useCurrentUser";
import { formatDateTime } from "@/lib/format";
import type { AlertItem, Paged, ReportDetail, ReportListItem } from "@/lib/types";
import { AlertCard } from "@/components/AlertCard";
import { BigButton } from "@/components/BigButton";
import { EmptyState, ErrorState, LoadingState } from "@/components/ErrorState";
import { PageHeader } from "@/components/PageHeader";
import { ReportSectionsView } from "@/components/ReportSectionsView";

function toItems<T>(payload: T[] | Paged<T> | null | undefined): T[] {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  return payload.items ?? [];
}

export default function ElderReportPage() {
  const { user } = useCurrentUser();
  // patient_id 保持后端原样（整数主键）：查询参数由 api 层转字符串
  const patientId = user?.patient_id ?? null;

  const [reports, setReports] = useState<ReportListItem[]>([]);
  const [activeId, setActiveId] = useState<string | number>("");
  const [detail, setDetail] = useState<ReportDetail | null>(null);
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (patientId === null || patientId === "") {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const [reportPayload, alertPayload] = await Promise.all([
        api.get<ReportListItem[] | Paged<ReportListItem>>("/reports", {
          patient_id: patientId,
        }),
        api.get<AlertItem[] | Paged<AlertItem>>("/alerts", {
          patient_id: patientId,
        }),
      ]);
      const reportItems = toItems(reportPayload);
      setReports(reportItems);
      setAlerts(toItems(alertPayload));
      if (reportItems.length) setActiveId((prev) => prev || reportItems[0].id);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "暂时无法获取报告，请稍后重试或联系工作人员。",
      );
    } finally {
      setLoading(false);
    }
  }, [patientId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!activeId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    api
      .get<ReportDetail>(`/reports/${activeId}`)
      .then((data) => {
        if (!cancelled) setDetail(data);
      })
      .catch(() => {
        if (!cancelled) setDetail(null);
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeId]);

  if (loading) {
    return <LoadingState label="正在加载您的报告…" />;
  }

  if (error) {
    return <ErrorState message={error} onRetry={() => void load()} />;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="我的报告与提醒"
        description="这里可以查看老年综合评估报告，以及医生给出的就医提醒。"
      />

      {reports.length ? (
        <section className="card card-pad">
          <h2 className="text-elder-lg font-semibold text-ink">选择报告</h2>
          <ul className="mt-4 space-y-3">
            {reports.map((report) => {
              const active = report.id === activeId;
              return (
                <li key={String(report.id)}>
                  <button
                    type="button"
                    onClick={() => setActiveId(report.id)}
                    aria-pressed={active}
                    className={[
                      "flex w-full flex-wrap items-center justify-between gap-3 rounded-xl border-2 px-5 py-4 text-left transition-colors",
                      active
                        ? "border-medical-700 bg-medical-50"
                        : "border-slate-300 bg-white hover:border-medical-400",
                    ].join(" ")}
                  >
                    <span>
                      <span className="block text-elder-lg font-semibold text-ink">
                        {report.title || "老年综合评估报告"}
                        {report.version ? `（第 ${report.version} 版）` : ""}
                      </span>
                      <span className="mt-1 block text-elder text-ink-soft">
                        生成时间：{formatDateTime(report.created_at)}
                      </span>
                    </span>
                    {active ? (
                      <span className="rounded-full bg-medical-700 px-4 py-1 text-elder font-semibold text-white">
                        正在查看
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : (
        <EmptyState message="暂无可查看的报告，完成评估后由工作人员生成。" />
      )}

      {detailLoading ? <LoadingState label="正在加载报告内容…" /> : null}

      {detail ? (
        <ReportSectionsView sections={detail.sections} disclaimer={detail.disclaimer} />
      ) : null}

      <section className="space-y-4">
        <h2 className="text-elder-lg font-semibold text-ink">就医提醒</h2>
        {alerts.length === 0 ? (
          <EmptyState message="目前没有需要处理的提醒。" />
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

      <div className="flex flex-wrap gap-3">
        <BigButton variant="secondary" size="lg" onClick={() => void load()}>
          刷新
        </BigButton>
      </div>
    </div>
  );
}
