"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Download, RefreshCw } from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CompactTable,
  type TableColumn,
} from "@/components/CompactTable";
import { useToast } from "@/components/Toast";
import {
  ClinEmpty,
  ClinError,
  ClinLoading,
  ClinPageHeader,
  ClinSection,
  ClinStatRow,
} from "@/app/staff/_components/clinical";

function toItems<T>(payload: T[] | Paged<T> | null | undefined): T[] {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  return payload.items ?? [];
}

const STATUS_OPTIONS = [
  { value: "all", label: "全部状态" },
  { value: "in_progress", label: "进行中" },
  { value: "finished", label: "已完成" },
  { value: "reviewed", label: "已复核" },
  { value: "abandoned", label: "已放弃" },
];

const STATUS_VARIANT: Record<string, "default" | "secondary" | "success" | "warning"> = {
  reviewed: "success",
  finished: "default",
  in_progress: "warning",
  abandoned: "secondary",
};

export default function StaffTaskPage() {
  const toast = useToast();

  const [patients, setPatients] = useState<Patient[]>([]);
  const [scales, setScales] = useState<ScaleListItem[]>([]);
  const [tasks, setTasks] = useState<AssessmentListItem[]>([]);
  const [stats, setStats] = useState<StatsOverview | null>(null);

  const [patientId, setPatientId] = useState("all");
  const [scaleCode, setScaleCode] = useState("all");
  const [status, setStatus] = useState("all");
  const [keyword, setKeyword] = useState("");

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
          patient_id: patientId === "all" ? undefined : patientId,
          scale_code: scaleCode === "all" ? undefined : scaleCode,
          status: status === "all" ? undefined : status,
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
          className="font-medium text-clin-accent hover:underline"
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
        <span>
          {task.scale_name || task.scale_code}
          <span className="ml-2 text-clin-xs text-clin-fg-subtle">
            {task.scale_code}
          </span>
        </span>
      ),
    },
    {
      key: "status",
      header: "状态",
      sortValue: (task) => task.status,
      className: "w-[96px]",
      render: (task) => (
        <Badge variant={STATUS_VARIANT[task.status] ?? "secondary"}>
          {assessmentStatusLabel(task.status)}
        </Badge>
      ),
    },
    {
      key: "progress",
      header: "进度",
      sortValue: (task) =>
        normalizeProgress(task.progress, task.total_questions).percent,
      className: "w-[140px]",
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
      className: "w-[92px]",
      render: (task) => (
        <span className="text-clin-fg-muted">
          {task.mode === "staff" ? "医护代填" : "老人自填"}
        </span>
      ),
    },
    {
      key: "updated",
      header: "更新时间",
      sortValue: (task) =>
        task.finished_at ?? task.started_at ?? task.created_at ?? "",
      className: "w-[140px]",
      render: (task) => (
        <span className="text-clin-fg-muted">
          {formatDateTime(task.finished_at ?? task.started_at ?? task.created_at)}
        </span>
      ),
    },
    {
      key: "action",
      header: "操作",
      className: "w-[92px]",
      render: (task) => (
        <Link
          href={`/staff/review/${task.id}`}
          className="text-clin-sm text-clin-accent hover:underline"
        >
          查看／复核
        </Link>
      ),
    },
  ];

  const statItems = [
    { label: "患者数", value: stats?.patients ?? "—" },
    { label: "评估数", value: stats?.assessments ?? "—" },
    { label: "待复核", value: stats?.pending_review ?? "—" },
    { label: "异常评估", value: stats?.abnormal_assessments ?? "—" },
  ];

  return (
    <div>
      <ClinPageHeader
        title="评估任务"
        description="按患者、量表与状态筛选评估记录，支持多选后批量复核与脱敏导出。"
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              刷新
            </Button>
            <Link href="/staff/quality">
              <Button variant="outline" size="sm">
                质控看板
              </Button>
            </Link>
          </>
        }
      />

      <ClinStatRow items={statItems} />

      <ClinSection title="筛选条件" className="mt-6">
        <div className="grid gap-3 md:grid-cols-4">
          <div>
            <Label htmlFor="filter-patient">患者</Label>
            <Select value={patientId} onValueChange={setPatientId}>
              <SelectTrigger id="filter-patient" className="mt-1">
                <SelectValue placeholder="全部患者" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部患者</SelectItem>
                {patients.map((patient) => (
                  <SelectItem key={patient.id} value={String(patient.id)}>
                    {patient.name}（{patient.code ?? patient.id}）
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="filter-scale">量表</Label>
            <Select value={scaleCode} onValueChange={setScaleCode}>
              <SelectTrigger id="filter-scale" className="mt-1">
                <SelectValue placeholder="全部量表" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部量表</SelectItem>
                {scales.map((scale) => (
                  <SelectItem key={scale.code} value={scale.code}>
                    {scale.code} {scale.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="filter-status">状态</Label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger id="filter-status" className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="filter-keyword">关键字</Label>
            <Input
              id="filter-keyword"
              className="mt-1"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="姓名 / 量表 / 任务号"
            />
          </div>
        </div>
      </ClinSection>

      <ClinSection title="任务列表">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <span className="text-clin-xs text-clin-fg-muted">
            共 {filteredTasks.length} 条
            {selected.size > 0 ? `，已选 ${selected.size} 条` : ""}
          </span>
          {selected.size > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" loading={batchRunning} onClick={() => void runBatchReview()}>
                批量复核（{selected.size}）
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={batchRunning}
                onClick={() => setExportOpen(true)}
              >
                <Download className="h-3.5 w-3.5" aria-hidden="true" />
                批量导出
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
                清除选择
              </Button>
            </div>
          ) : null}
        </div>

        {loading ? (
          <ClinLoading label="正在加载评估任务…" />
        ) : error ? (
          <ClinError message={error} onRetry={() => void load()} />
        ) : filteredTasks.length === 0 ? (
          <ClinEmpty message="没有符合条件的评估记录。" />
        ) : (
          <>
            <CompactTable
              columns={columns}
              rows={filteredTasks}
              rowKey={(task) => String(task.id)}
              selectable
              selectedKeys={selected}
              onToggleRow={toggleRow}
              onToggleAll={toggleAll}
              emptyMessage="没有符合条件的评估记录。"
            />

            {exportOpen ? (
              <div className="mt-4 rounded-clin border border-clin-warning px-4 py-3">
                <p className="text-clin-sm font-medium text-clin-fg">
                  确认导出 {selected.size} 条评估任务记录？
                </p>
                <p className="mt-1 text-clin-xs text-clin-fg-muted">
                  导出文件仅包含任务号、患者编号、姓名、量表、状态、进度与时间，
                  <strong>不含身份证号与联系电话</strong>，仍含个人健康相关信息，
                  请按院内数据管理要求妥善保管与销毁。
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" onClick={runBatchExport}>
                    确认导出
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setExportOpen(false)}>
                    取消
                  </Button>
                </div>
              </div>
            ) : null}
          </>
        )}
      </ClinSection>
    </div>
  );
}
