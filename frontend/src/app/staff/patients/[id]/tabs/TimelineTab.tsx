"use client";

import { formatDateTime } from "@/lib/format";
import type { TimelineEvent } from "@/lib/types";
import { EmptyState } from "@/components/ErrorState";
import { SectionTitle } from "@/components/PageHeader";

/** 时间轴 tab：评估、报告、提醒与随访的历史轨迹 */
export function TimelineTab({ timeline }: { timeline: TimelineEvent[] }) {
  return (
    <section className="card card-pad">
      <SectionTitle title="患者时间轴" />
      {timeline.length === 0 ? (
        <EmptyState message="暂无时间轴记录。" />
      ) : (
        <ol className="space-y-4 border-l-2 border-slate-200 pl-6">
          {timeline.map((event, index) => (
            <li key={event.id ?? index} className="relative">
              <span
                aria-hidden="true"
                className="absolute -left-[31px] top-2 h-3 w-3 rounded-full bg-medical-700"
              />
              <p className="text-elder font-semibold text-ink">
                {event.title ?? event.category ?? event.type ?? "记录"}
              </p>
              <p className="mt-1 text-elder text-ink-soft">
                {event.description ?? "—"}
              </p>
              <p className="mt-1 text-elder text-ink-mute">
                {formatDateTime(event.created_at)}
                {event.operator ? ` · ${event.operator}` : ""}
              </p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
