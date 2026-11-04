"use client";

import Link from "next/link";
import { assessmentStatusLabel, formatDateTime } from "@/lib/format";
import type { AssessmentListItem } from "@/lib/types";
import { BigButton } from "@/components/BigButton";
import { EmptyState } from "@/components/ErrorState";
import { StatusBadge } from "@/components/StatusBadge";

/** 评估 tab：该患者的全部评估记录与判读结果 */
export function AssessmentsTab({
  assessments,
}: {
  assessments: AssessmentListItem[];
}) {
  if (assessments.length === 0) {
    return (
      <section className="card">
        <div className="card-pad">
          <EmptyState message="该患者暂无评估记录。" />
        </div>
      </section>
    );
  }

  return (
    <section className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-left">
          <thead className="border-b border-slate-200 bg-slate-50">
            <tr>
              <th className="px-5 py-3 text-elder font-semibold text-ink">量表</th>
              <th className="px-5 py-3 text-elder font-semibold text-ink">状态</th>
              <th className="px-5 py-3 text-elder font-semibold text-ink">方式</th>
              <th className="px-5 py-3 text-elder font-semibold text-ink">判读结果</th>
              <th className="px-5 py-3 text-elder font-semibold text-ink">创建时间</th>
              <th className="px-5 py-3 text-elder font-semibold text-ink">操作</th>
            </tr>
          </thead>
          <tbody>
            {assessments.map((item) => (
              <tr key={item.id} className="border-b border-slate-100 last:border-0">
                <td className="px-5 py-3 text-elder text-ink">
                  {item.scale_name || item.scale_code}
                </td>
                <td className="px-5 py-3">
                  <StatusBadge
                    label={assessmentStatusLabel(item.status)}
                    tone={
                      item.status === "reviewed"
                        ? "green"
                        : item.status === "in_progress"
                          ? "blue"
                          : "gray"
                    }
                  />
                </td>
                <td className="px-5 py-3 text-elder text-ink-soft">
                  {item.mode === "staff" ? "医护代填" : "老人自填"}
                </td>
                <td className="px-5 py-3 text-elder text-ink-soft">
                  {item.score
                    ? `${item.score.total ?? "—"} 分 · ${item.score.level ?? "—"}`
                    : "未判读"}
                </td>
                <td className="px-5 py-3 text-elder text-ink-soft">
                  {formatDateTime(item.created_at)}
                </td>
                <td className="px-5 py-3">
                  <Link href={`/staff/review/${item.id}`}>
                    <BigButton variant="secondary">复核</BigButton>
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
