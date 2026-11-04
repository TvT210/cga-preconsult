"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import {
  assessmentStatusLabel,
  formatDateTime,
  normalizeProgress,
} from "@/lib/format";
import type {
  AssessmentListItem,
  Paged,
  Patient,
  ScaleListItem,
  StatsOverview,
} from "@/lib/types";
import { BigButton } from "@/components/BigButton";
import { EmptyState, ErrorState, LoadingState } from "@/components/ErrorState";
import { PageHeader, SectionTitle } from "@/components/PageHeader";
import { StatusBadge } from "@/components/StatusBadge";

function toItems<T>(payload: T[] | Paged<T> | null | undefined): T[] {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  return payload.items ?? [];
}

const STATUS_OPTIONS = [
  { value: "", label: "全部状态" },
  { value: "in_progress", label: "进行中" },
  { value: "finished", label: "已完成" },
  { value: "reviewed", label: "已复核" },
  { value: "abandoned", label: "已放弃" },
];

export default function StaffTaskPage() {
  const [patients, setPatients] = useState<Patient[]>([]);
  const [scales, setScales] = useState<ScaleListItem[]>([]);
  const [tasks, setTasks] = useState<AssessmentListItem[]>([]);
  const [stats, setStats] = useState<StatsOverview | null>(null);

  const [patientId, setPatientId] = useState("");
  const [scaleCode, setScaleCode] = useState("");
  const [status, setStatus] = useState("");
  const [keyword, setKeyword] = useState("");

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [taskPayload, patientPayload, scalePayload] = await Promise.all([
        api.get<AssessmentListItem[] | Paged<AssessmentListItem>>("/assessments", {
          patient_id: patientId || undefined,
          scale_code: scaleCode || undefined,
          status: status || undefined,
        }),
        api.get<Patient[] | Paged<Patient>>("/patients", { size: 200 }),
        api.get<ScaleListItem[] | Paged<ScaleListItem>>("/scales"),
      ]);
      setTasks(toItems(taskPayload));
      setPatients(toItems(patientPayload));
      setScales(toItems(scalePayload));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "暂时无法获取评估任务列表。",
      );
    } finally {
      setLoading(false);
    }
  }, [patientId, scaleCode, status]);

  useEffect(() => {
    void load();
  }, [load]);

  // 看板汇总接口仅部分角色可用，失败时静默忽略
  useEffect(() => {
    api
      .get<StatsOverview>("/admin/stats/overview")
      .then(setStats)
      .catch(() => setStats(null));
  }, []);

  const patientName = useMemo(() => {
    const map = new Map<string, string>();
    patients.forEach((patient) => map.set(String(patient.id), patient.name));
    return map;
  }, [patients]);

  const filteredTasks = useMemo(() => {
    const key = keyword.trim();
    if (!key) return tasks;
    return tasks.filter((task) => {
      const name = patientName.get(String(task.patient_id)) ?? "";
      return (
        task.scale_code?.includes(key) ||
        task.scale_name?.includes(key) ||
        String(task.id).includes(key) ||
        name.includes(key)
      );
    });
  }, [tasks, keyword, patientName]);

  const statCards = [
    { label: "患者数", value: stats?.patients },
    { label: "评估数", value: stats?.assessments },
    { label: "异常评估", value: stats?.abnormal_assessments },
    { label: "报告数", value: stats?.reports },
    { label: "待复核", value: stats?.pending_review },
    { label: "提醒数", value: stats?.alerts },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="评估任务"
        description="按患者、量表与状态筛选评估记录，可进入复核页查看作答明细并质评。"
      />

      {statCards.some((item) => item.value !== undefined) ? (
        <section className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
          {statCards.map((item) => (
            <div key={item.label} className="card card-pad">
              <p className="text-elder text-ink-soft">{item.label}</p>
              <p className="mt-1 text-elder-2xl font-bold text-medical-800">
                {item.value ?? "—"}
              </p>
            </div>
          ))}
        </section>
      ) : null}

      <section className="card card-pad">
        <SectionTitle title="筛选条件" />
        <div className="grid gap-4 md:grid-cols-4">
          <div>
            <label className="field-label" htmlFor="filter-patient">
              患者
            </label>
            <select
              id="filter-patient"
              className="field-select"
              value={patientId}
              onChange={(event) => setPatientId(event.target.value)}
            >
              <option value="">全部患者</option>
              {patients.map((patient) => (
                <option key={patient.id} value={patient.id}>
                  {patient.name}（{patient.code ?? patient.id}）
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="field-label" htmlFor="filter-scale">
              量表
            </label>
            <select
              id="filter-scale"
              className="field-select"
              value={scaleCode}
              onChange={(event) => setScaleCode(event.target.value)}
            >
              <option value="">全部量表</option>
              {scales.map((scale) => (
                <option key={scale.code} value={scale.code}>
                  {scale.code} {scale.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="field-label" htmlFor="filter-status">
              状态
            </label>
            <select
              id="filter-status"
              className="field-select"
              value={status}
              onChange={(event) => setStatus(event.target.value)}
            >
              {STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="field-label" htmlFor="filter-keyword">
              关键字
            </label>
            <input
              id="filter-keyword"
              className="field-input"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="姓名 / 量表 / 任务号"
            />
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-3">
          <BigButton variant="secondary" onClick={() => void load()}>
            刷新列表
          </BigButton>
        </div>
      </section>

      {loading ? (
        <LoadingState label="正在加载评估任务…" />
      ) : error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : filteredTasks.length === 0 ? (
        <EmptyState message="没有符合条件的评估记录。" />
      ) : (
        <section className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-left">
              <thead className="border-b border-slate-200 bg-slate-50">
                <tr>
                  <th className="px-5 py-3 text-elder font-semibold text-ink">患者</th>
                  <th className="px-5 py-3 text-elder font-semibold text-ink">量表</th>
                  <th className="px-5 py-3 text-elder font-semibold text-ink">状态</th>
                  <th className="px-5 py-3 text-elder font-semibold text-ink">进度</th>
                  <th className="px-5 py-3 text-elder font-semibold text-ink">采集方式</th>
                  <th className="px-5 py-3 text-elder font-semibold text-ink">更新时间</th>
                  <th className="px-5 py-3 text-elder font-semibold text-ink">操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredTasks.map((task) => {
                  const progress = normalizeProgress(
                    task.progress,
                    task.total_questions,
                  );
                  return (
                    <tr key={task.id} className="border-b border-slate-100 last:border-0">
                      <td className="px-5 py-3 text-elder text-ink">
                        <Link
                          href={`/staff/patients/${task.patient_id}`}
                          className="text-medical-700 underline"
                        >
                          {patientName.get(String(task.patient_id)) ?? task.patient_id}
                        </Link>
                      </td>
                      <td className="px-5 py-3 text-elder text-ink">
                        {task.scale_name || task.scale_code}
                      </td>
                      <td className="px-5 py-3">
                        <StatusBadge
                          label={assessmentStatusLabel(task.status)}
                          tone={
                            task.status === "finished"
                              ? "green"
                              : task.status === "in_progress"
                                ? "blue"
                                : task.status === "reviewed"
                                  ? "green"
                                  : "gray"
                          }
                        />
                      </td>
                      <td className="px-5 py-3 text-elder text-ink-soft">
                        {progress.total
                          ? `${progress.answered} / ${progress.total}（${progress.percent}%）`
                          : `已答 ${progress.answered} 题`}
                      </td>
                      <td className="px-5 py-3 text-elder text-ink-soft">
                        {task.mode === "staff" ? "医护代填" : "老人自填"}
                      </td>
                      <td className="px-5 py-3 text-elder text-ink-soft">
                        {formatDateTime(task.finished_at ?? task.started_at ?? task.created_at)}
                      </td>
                      <td className="px-5 py-3">
                        <Link href={`/staff/review/${task.id}`}>
                          <BigButton variant="secondary">查看／复核</BigButton>
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
