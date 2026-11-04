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
import {
  CompactTable,
  type TableColumn,
  type TableDensity,
} from "@/components/CompactTable";
import { EmptyState, ErrorState, LoadingState } from "@/components/ErrorState";
import { PageHeader, SectionTitle } from "@/components/PageHeader";
import { StatusBadge } from "@/components/StatusBadge";
import { useToast } from "@/components/Toast";

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
  const toast = useToast();

  const [patients, setPatients] = useState<Patient[]>([]);
  const [scales, setScales] = useState<ScaleListItem[]>([]);
  const [tasks, setTasks] = useState<AssessmentListItem[]>([]);
  const [stats, setStats] = useState<StatsOverview | null>(null);

  const [patientId, setPatientId] = useState("");
  const [scaleCode, setScaleCode] = useState("");
  const [status, setStatus] = useState("");
  const [keyword, setKeyword] = useState("");

  const [density, setDensity] = useState<TableDensity>("compact");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchRunning, setBatchRunning] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);

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

  const patientCode = useMemo(() => {
    const map = new Map<string, string>();
    patients.forEach((patient) =>
      map.set(String(patient.id), patient.code ?? String(patient.id)),
    );
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

  /** 批量复核：逐条调用复核接口，汇总成功与失败 */
  const runBatchReview = useCallback(async () => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    setBatchRunning(true);
    const results = await Promise.allSettled(
      ids.map((id) =>
        api.post(`/assessments/${id}/review`, {
          action: "approve",
          corrections: [],
          comment: "批量复核通过",
        }),
      ),
    );
    const failed = results.filter((item) => item.status === "rejected").length;
    const succeeded = results.length - failed;
    setBatchRunning(false);
    setSelected(new Set());
    if (failed === 0) {
      toast(`已批量复核 ${succeeded} 条评估。`, "success");
    } else {
      toast(`批量复核完成：成功 ${succeeded} 条，失败 ${failed} 条。`, "warning");
    }
    await load();
  }, [load, selected, toast]);

  /** 批量导出：CSV，仅导出脱敏后的字段（不含身份证号与联系电话） */
  const runBatchExport = useCallback(() => {
    const rows = filteredTasks.filter((task) => selected.has(String(task.id)));
    if (rows.length === 0) return;

    const header = [
      "任务号",
      "患者编号",
      "患者姓名",
      "量表编码",
      "量表名称",
      "状态",
      "已答题数",
      "题目总数",
      "采集方式",
      "更新时间",
    ];
    const body = rows.map((task) => {
      const progress = normalizeProgress(task.progress, task.total_questions);
      return [
        String(task.id),
        patientCode.get(String(task.patient_id)) ?? String(task.patient_id),
        patientName.get(String(task.patient_id)) ?? "",
        task.scale_code ?? "",
        task.scale_name ?? "",
        assessmentStatusLabel(task.status),
        String(progress.answered),
        String(progress.total),
        task.mode === "staff" ? "医护代填" : "老人自填",
        formatDateTime(task.finished_at ?? task.started_at ?? task.created_at),
      ];
    });

    const csv = [header, ...body]
      .map((line) =>
        line
          .map((cell) => `"${String(cell).replace(/"/g, '""')}"`)
          .join(","),
      )
      .join("\r\n");

    // 加 BOM，保证 Excel 打开中文不乱码
    const blob = new Blob(["\uFEFF", csv], {
      type: "text/csv;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    anchor.href = url;
    anchor.download = `评估任务导出_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(
      now.getDate(),
    )}_${pad(now.getHours())}${pad(now.getMinutes())}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
    setExportOpen(false);
    toast(`已导出 ${rows.length} 条记录（已脱敏）。`, "success");
  }, [filteredTasks, patientCode, patientName, selected, toast]);

  const toggleRow = useCallback((key: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const toggleAll = useCallback(
    (checked: boolean) => {
      if (checked) {
        setSelected(new Set(filteredTasks.map((task) => String(task.id))));
      } else {
        setSelected(new Set());
      }
    },
    [filteredTasks],
  );

  const columns: TableColumn<AssessmentListItem>[] = [
    {
      key: "patient",
      header: "患者",
      sortValue: (task) => patientName.get(String(task.patient_id)) ?? "",
      className: "min-w-[140px]",
      render: (task) => (
        <Link
          href={`/staff/patients/${task.patient_id}`}
          className="font-semibold text-medical-700 underline"
        >
          {patientName.get(String(task.patient_id)) ?? task.patient_id}
        </Link>
      ),
    },
    {
      key: "scale",
      header: "量表",
      sortValue: (task) => task.scale_name || task.scale_code,
      className: "min-w-[180px]",
      render: (task) => (
        <span className="text-ink">
          {task.scale_name || task.scale_code}
          <span className="ml-2 text-xs text-ink-mute">{task.scale_code}</span>
        </span>
      ),
    },
    {
      key: "status",
      header: "状态",
      sortValue: (task) => task.status,
      className: "w-[110px]",
      render: (task) => (
        <StatusBadge
          label={assessmentStatusLabel(task.status)}
          tone={
            task.status === "reviewed"
              ? "green"
              : task.status === "finished"
                ? "green"
                : task.status === "in_progress"
                  ? "blue"
                  : "gray"
          }
        />
      ),
    },
    {
      key: "progress",
      header: "进度",
      sortValue: (task) => normalizeProgress(task.progress, task.total_questions).percent,
      className: "w-[130px]",
      render: (task) => {
        const progress = normalizeProgress(task.progress, task.total_questions);
        return progress.total
          ? `${progress.answered} / ${progress.total}（${progress.percent}%）`
          : `已答 ${progress.answered} 题`;
      },
    },
    {
      key: "mode",
      header: "采集方式",
      sortValue: (task) => task.mode ?? "",
      className: "w-[100px]",
      render: (task) => (
        <span className="text-ink-soft">
          {task.mode === "staff" ? "医护代填" : "老人自填"}
        </span>
      ),
    },
    {
      key: "updated",
      header: "更新时间",
      sortValue: (task) =>
        task.finished_at ?? task.started_at ?? task.created_at ?? "",
      className: "w-[150px]",
      render: (task) => (
        <span className="text-ink-soft">
          {formatDateTime(task.finished_at ?? task.started_at ?? task.created_at)}
        </span>
      ),
    },
    {
      key: "action",
      header: "操作",
      className: "w-[120px]",
      render: (task) => (
        <Link href={`/staff/review/${task.id}`}>
          <BigButton variant="secondary">查看／复核</BigButton>
        </Link>
      ),
    },
  ];

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
        description="按患者、量表与状态筛选评估记录，支持多选后批量复核与脱敏导出。"
        actions={
          <Link href="/staff/quality">
            <BigButton variant="secondary" size="lg">
              打开质控看板
            </BigButton>
          </Link>
        }
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
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-3">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-elder text-ink-soft">
                共 {filteredTasks.length} 条
                {selected.size > 0 ? `，已选 ${selected.size} 条` : ""}
              </span>
              {selected.size > 0 ? (
                <>
                  <BigButton
                    size="md"
                    loading={batchRunning}
                    onClick={() => void runBatchReview()}
                  >
                    批量复核（{selected.size}）
                  </BigButton>
                  <BigButton
                    variant="secondary"
                    disabled={batchRunning}
                    onClick={() => setExportOpen(true)}
                  >
                    批量导出
                  </BigButton>
                  <BigButton variant="ghost" onClick={() => setSelected(new Set())}>
                    清除选择
                  </BigButton>
                </>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-elder text-ink-soft">密度</span>
              <button
                type="button"
                onClick={() => setDensity("compact")}
                aria-pressed={density === "compact"}
                className={[
                  "rounded-lg border-2 px-3 py-1 text-elder font-semibold",
                  density === "compact"
                    ? "border-medical-700 bg-medical-700 text-white"
                    : "border-slate-300 bg-white text-ink",
                ].join(" ")}
              >
                紧凑
              </button>
              <button
                type="button"
                onClick={() => setDensity("normal")}
                aria-pressed={density === "normal"}
                className={[
                  "rounded-lg border-2 px-3 py-1 text-elder font-semibold",
                  density === "normal"
                    ? "border-medical-700 bg-medical-700 text-white"
                    : "border-slate-300 bg-white text-ink",
                ].join(" ")}
              >
                标准
              </button>
            </div>
          </div>

          <CompactTable
            columns={columns}
            rows={filteredTasks}
            rowKey={(task) => String(task.id)}
            selectable
            selectedKeys={selected}
            onToggleRow={toggleRow}
            onToggleAll={toggleAll}
            density={density}
            emptyMessage="没有符合条件的评估记录。"
          />

          {exportOpen ? (
            <div className="border-t border-slate-200 px-5 py-4">
              <div className="rounded-xl2 border-2 border-amber-300 bg-amber-50 p-4">
                <p className="text-elder font-semibold text-amber-900">
                  确认导出 {selected.size} 条评估任务记录？
                </p>
                <p className="mt-2 text-elder text-amber-900">
                  导出文件仅包含任务号、患者编号、姓名、量表、状态、进度与时间，
                  <strong>不含身份证号与联系电话</strong>，仍含个人健康相关信息，
                  请按院内数据管理要求妥善保管与销毁。
                </p>
                <div className="mt-4 flex flex-wrap gap-3">
                  <BigButton onClick={runBatchExport}>确认导出</BigButton>
                  <BigButton variant="ghost" onClick={() => setExportOpen(false)}>
                    取消
                  </BigButton>
                </div>
              </div>
            </div>
          ) : null}
        </section>
      )}
    </div>
  );
}
