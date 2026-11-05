"use client";

import Link from "next/link";
import { assessmentStatusLabel, formatDateTime } from "@/lib/format";
import type { AssessmentListItem } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { ClinEmpty, ClinSection } from "@/app/staff/_components/clinical";

/** 评估 tab：该患者的全部评估记录与判读结果 */
export function AssessmentsTab({
  assessments,
}: {
  assessments: AssessmentListItem[];
}) {
  if (assessments.length === 0) {
    return (
      <ClinSection title="评估记录">
        <ClinEmpty message="该患者暂无评估记录。" />
      </ClinSection>
    );
  }

  return (
    <ClinSection title="评估记录">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-left">
          <thead className="border-b border-clin-border bg-clin-muted">
            <tr>
              <th className="px-3 py-2 text-clin-xs font-medium text-clin-fg-muted">
                量表
              </th>
              <th className="px-3 py-2 text-clin-xs font-medium text-clin-fg-muted">
                状态
              </th>
              <th className="px-3 py-2 text-clin-xs font-medium text-clin-fg-muted">
                方式
              </th>
              <th className="px-3 py-2 text-clin-xs font-medium text-clin-fg-muted">
                判读结果
              </th>
              <th className="px-3 py-2 text-clin-xs font-medium text-clin-fg-muted">
                创建时间
              </th>
              <th className="px-3 py-2 text-clin-xs font-medium text-clin-fg-muted">
                操作
              </th>
            </tr>
          </thead>
          <tbody>
            {assessments.map((item) => (
              <tr
                key={item.id}
                className="border-b border-clin-border transition-colors duration-150 last:border-0 hover:bg-clin-muted"
              >
                <td className="px-3 py-2 text-clin-sm text-clin-fg">
                  {item.scale_name || item.scale_code}
                </td>
                <td className="px-3 py-2">
                  <Badge
                    variant={
                      item.status === "reviewed"
                        ? "success"
                        : item.status === "in_progress"
                          ? "warning"
                          : "secondary"
                    }
                  >
                    {assessmentStatusLabel(item.status)}
                  </Badge>
                </td>
                <td className="px-3 py-2 text-clin-sm text-clin-fg-muted">
                  {item.mode === "staff" ? "医护代填" : "老人自填"}
                </td>
                <td className="px-3 py-2 text-clin-sm tabular-nums text-clin-fg-muted">
                  {item.score
                    ? `${item.score.total ?? "—"} 分 · ${item.score.level ?? "—"}`
                    : "未判读"}
                </td>
                <td className="px-3 py-2 text-clin-sm text-clin-fg-muted">
                  {formatDateTime(item.created_at)}
                </td>
                <td className="px-3 py-2">
                  <Link
                    href={`/staff/review/${item.id}`}
                    className="text-clin-sm text-clin-accent hover:underline"
                  >
                    复核
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ClinSection>
  );
}
