"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { assessmentStatusLabel, formatDateTime } from "@/lib/format";
import type { AssessmentListItem, Paged, Patient } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { toItems } from "./usePatientWorkspace";

/** 患者在左侧列表中的展示条目 */
interface PatientListEntry {
  patient: Patient;
  /** 最近一次评估的状态 */
  latestStatus?: string;
  /** 最近一次评估的时间 */
  latestAt?: string;
  /** 待复核数量 */
  pendingCount: number;
}

type SortKey = "recent" | "name" | "created";

const STATUS_FILTERS = [
  { value: "all", label: "全部" },
  { value: "pending", label: "待复核" },
  { value: "in_progress", label: "进行中" },
  { value: "reviewed", label: "已复核" },
  { value: "none", label: "无评估" },
];

function timeValue(value?: string): number {
  if (!value) return 0;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

/**
 * 左侧患者列表面板：可搜索、可按状态筛选，默认按最近评估排序。
 * 选中状态由上层通过 URL query 同步，刷新不丢。
 */
export function PatientListPanel({
  selectedId,
  onSelect,
}: {
  selectedId?: string;
  onSelect: (patientId: string) => void;
}) {
  const [patients, setPatients] = useState<Patient[]>([]);
  const [sessions, setSessions] = useState<AssessmentListItem[]>([]);
  const [keyword, setKeyword] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sortKey, setSortKey] = useState<SortKey>("recent");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [patientPayload, assessmentPayload] = await Promise.all([
        api.get<Patient[] | Paged<Patient>>("/patients", { size: 200 }),
        api.get<AssessmentListItem[] | Paged<AssessmentListItem>>("/assessments", {
          size: 100,
        }),
      ]);
      setPatients(toItems(patientPayload));
      setSessions(toItems(assessmentPayload));
    } catch (err) {
      setError(err instanceof Error ? err.message : "暂时无法获取患者列表。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** 汇总每位患者的最近评估与待复核数量 */
  const entries = useMemo<PatientListEntry[]>(() => {
    const byPatient = new Map<string, AssessmentListItem[]>();
    sessions.forEach((session) => {
      const key = String(session.patient_id);
      const list = byPatient.get(key) ?? [];
      list.push(session);
      byPatient.set(key, list);
    });

    return patients.map((patient) => {
      const list = byPatient.get(String(patient.id)) ?? [];
      const latest = [...list].sort(
        (left, right) =>
          timeValue(right.finished_at ?? right.started_at ?? right.created_at) -
          timeValue(left.finished_at ?? left.started_at ?? left.created_at),
      )[0];
      return {
        patient,
        latestStatus: latest?.status,
        latestAt: latest?.finished_at ?? latest?.started_at ?? latest?.created_at,
        pendingCount: list.filter((item) => item.status === "finished").length,
      };
    });
  }, [patients, sessions]);

  /** 搜索 + 状态筛选 + 排序 */
  const visible = useMemo(() => {
    const key = keyword.trim().toLowerCase();
    let list = entries.filter((entry) => {
      const name = entry.patient.name?.toLowerCase() ?? "";
      const code = (entry.patient.code ?? "").toLowerCase();
      if (key && !name.includes(key) && !code.includes(key)) return false;

      if (statusFilter === "all") return true;
      if (statusFilter === "none") return !entry.latestStatus;
      if (statusFilter === "pending") {
        return entry.pendingCount > 0 || entry.latestStatus === "finished";
      }
      return entry.latestStatus === statusFilter;
    });

    list = [...list].sort((left, right) => {
      if (sortKey === "name") {
        return (left.patient.name ?? "").localeCompare(
          right.patient.name ?? "",
          "zh-CN",
        );
      }
      if (sortKey === "created") {
        return (
          timeValue(right.patient.created_at) - timeValue(left.patient.created_at)
        );
      }
      // 默认：按最近评估排序，无评估记录的患者排在最后
      const leftTime = timeValue(left.latestAt);
      const rightTime = timeValue(right.latestAt);
      if (leftTime === rightTime) {
        return (left.patient.name ?? "").localeCompare(
          (right.patient.name ?? "").toString(),
          "zh-CN",
        );
      }
      return rightTime - leftTime;
    });

    return list;
  }, [entries, keyword, sortKey, statusFilter]);

  return (
    <section className="flex h-full flex-col overflow-hidden rounded-clin border border-clin-border bg-clin-surface">
      <div className="border-b border-clin-border bg-clin-muted px-3 py-2.5">
        <p className="text-clin-sm font-medium text-clin-fg">患者列表</p>
        <p className="mt-0.5 text-clin-xs text-clin-fg-muted">
          共 {entries.length} 位，当前显示 {visible.length} 位
        </p>

        <div className="mt-2 space-y-2">
          <Input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="搜索姓名 / 编号"
            aria-label="搜索患者"
          />
          <div className="grid grid-cols-2 gap-2">
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger aria-label="按状态筛选">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_FILTERS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={sortKey}
              onValueChange={(value) => setSortKey(value as SortKey)}
            >
              <SelectTrigger aria-label="排序方式">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="recent">按最近评估排序</SelectItem>
                <SelectItem value="name">按姓名排序</SelectItem>
                <SelectItem value="created">按建档时间排序</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <p className="px-3 py-6 text-center text-clin-sm text-clin-fg-muted">
            加载中…
          </p>
        ) : error ? (
          <p className="px-3 py-6 text-center text-clin-sm text-clin-danger">{error}</p>
        ) : visible.length === 0 ? (
          <p className="px-3 py-6 text-center text-clin-sm text-clin-fg-subtle">
            没有符合条件的患者。
          </p>
        ) : (
          <ul>
            {visible.map((entry) => {
              const active = String(entry.patient.id) === selectedId;
              return (
                <li key={String(entry.patient.id)}>
                  <button
                    type="button"
                    onClick={() => onSelect(String(entry.patient.id))}
                    aria-current={active ? "true" : undefined}
                    className={cn(
                      "w-full border-b border-clin-border border-l-2 px-3 py-2 text-left transition-colors duration-150",
                      active
                        ? "border-l-clin-accent bg-clin-accent-soft"
                        : "border-l-transparent hover:bg-clin-muted",
                    )}
                  >
                    <p className="text-clin-sm font-medium text-clin-fg">
                      {entry.patient.name}
                      <span className="ml-2 text-clin-xs font-normal text-clin-fg-subtle">
                        {entry.patient.code ?? entry.patient.id}
                      </span>
                    </p>
                    <p className="mt-0.5 text-clin-xs text-clin-fg-muted">
                      {entry.latestStatus
                        ? `${assessmentStatusLabel(entry.latestStatus)} · ${formatDateTime(
                            entry.latestAt,
                          )}`
                        : "暂无评估记录"}
                    </p>
                    {entry.pendingCount > 0 ? (
                      <div className="mt-1">
                        <Badge variant="warning">{entry.pendingCount} 条待复核</Badge>
                      </div>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
