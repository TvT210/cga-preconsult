"use client";

import { formatDateTime } from "@/lib/format";
import type { TimelineEvent } from "@/lib/types";
import { ClinEmpty, ClinSection } from "@/app/staff/_components/clinical";

/** 时间轴 tab：评估、报告、提醒与随访的历史轨迹 */
export function TimelineTab({ timeline }: { timeline: TimelineEvent[] }) {
  return (
    <ClinSection title="患者时间轴">
      {timeline.length === 0 ? (
        <ClinEmpty message="暂无时间轴记录。" />
      ) : (
        <ol className="space-y-4 border-l border-clin-border pl-5">
          {timeline.map((event, index) => (
            <li key={event.id ?? index} className="relative">
              <span
                aria-hidden="true"
                className="absolute -left-[23px] top-1.5 h-1.5 w-1.5 rounded-full bg-clin-accent"
              />
              <p className="text-clin-sm font-medium text-clin-fg">
                {event.title ?? event.category ?? event.type ?? "记录"}
              </p>
              <p className="mt-0.5 text-clin-sm text-clin-fg-muted">
                {event.description ?? "—"}
              </p>
              <p className="mt-0.5 text-clin-xs text-clin-fg-subtle">
                {formatDateTime(event.created_at)}
                {event.operator ? ` · ${event.operator}` : ""}
              </p>
            </li>
          ))}
        </ol>
      )}
    </ClinSection>
  );
}
