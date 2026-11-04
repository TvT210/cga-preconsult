"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { assessmentStatusLabel, formatDateTime } from "@/lib/format";
import type { AssessmentListItem, Paged, Patient } from "@/lib/types";
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
  { value: "", label: "全部" },
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
  const [statusFilter, setStatusFilter] = useState("");
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

      if (!statusFilter) return true;
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
          right.patient.name ?? "",
          "zh-CN",
        );
      }
      return rightTime - leftTime;
    });

    return list;
  }, [entries, keyword, sortKey, statusFilter]);

  return (
    <section className="card flex h-full flex-col overflow-hidden">
      <div className="border-b border-slate-200 bg-slate-50 px-4 py-3">
        <p className="text-elder font-semibold text-ink">患者列表</p>
        <p className="mt-1 text-sm text-ink-soft">
          共 {entries.length} 位，当前显示 {visible.length} 位
        </p>

        <div className="mt-3 space-y-2">
          <input
            className="field-input"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="搜索姓名 / 编号"
            aria-label="搜索患者"
          />
          <div className="grid grid-cols-2 gap-2">
            <select
              className="field-select"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
              aria-label="按状态筛选"
            >
              {STATUS_FILTERS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <select
              className="field-select"
              value={sortKey}
              onChange={(event) => setSortKey(event.target.value as SortKey)}
              aria-label="排序方式"
            >
              <option value="recent">按最近评估排序</option>
              <option value="name">按姓名排序</option>
              <option value="created">按建档时间排序</option>
            </select>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <p className="px-4 py-6 text-center text-elder text-ink-mute">加载中…</p>
        ) : error ? (
          <p className="px-4 py-6 text-center text-elder text-ink-mute">{error}</p>
        ) : visible.length === 0 ? (
          <p className="px-4 py-6 text-center text-elder text-ink-mute">
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
                    className={[
                      "w-full border-b border-slate-100 px-4 py-3 text-left transition-colors",
                      active
                        ? "bg-medical-50 shadow-[inset_4px_0_0_0_#1d4ed8]"
                        : "hover:bg-slate-50",
                    ].join(" ")}
                  >
                    <p className="text-elder font-semibold text-ink">
                      {entry.patient.name}
                      <span className="ml-2 text-sm font-normal text-ink-mute">
                        {entry.patient.code ?? entry.patient.id}
                      </span>
                    </p>
                    <p className="mt-1 text-sm text-ink-soft">
                      {entry.latestStatus
                        ? `${assessmentStatusLabel(entry.latestStatus)} · ${formatDateTime(
                            entry.latestAt,
                          )}`
                        : "暂无评估记录"}
                    </p>
                    {entry.pendingCount > 0 ? (
                      <p className="mt-1 text-sm font-semibold text-amber-700">
                        {entry.pendingCount} 条待复核
                      </p>
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
