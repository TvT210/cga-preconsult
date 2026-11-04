"use client";

import { useMemo } from "react";
import { formatDateTime } from "@/lib/format";
import type {
  AiReview,
  AlertItem,
  DialogueTurn,
  MatchRunDetail,
  MatchRunListItem,
} from "@/lib/types";
import { AiReviewPanel } from "@/components/AiReviewPanel";
import { AlertCard, type AlertAction } from "@/components/AlertCard";
import { BigButton } from "@/components/BigButton";
import { EmptyState } from "@/components/ErrorState";
import { MatchCandidateCard } from "@/components/MatchCandidateCard";
import { SectionTitle } from "@/components/PageHeader";

/** 匹配与提醒 tab：候选依据、规则/AI 双排序、提醒处理与对话回放 */
export function MatchingTab({
  runs,
  activeRun,
  aiReview,
  alerts,
  dialogueTurns,
  busy,
  onRunMatching,
  onOpenRun,
  onAiReview,
  onHandleAlert,
  onOpenDialogue,
}: {
  runs: MatchRunListItem[];
  activeRun: MatchRunDetail | null;
  aiReview: AiReview | null;
  alerts: AlertItem[];
  dialogueTurns: DialogueTurn[];
  busy: boolean;
  onRunMatching: () => void;
  onOpenRun: (runId: string | number) => void;
  onAiReview: (runId: string | number) => void;
  onHandleAlert: (
    alertId: string | number,
    action: AlertAction,
    comment: string,
  ) => void;
  onOpenDialogue: () => void;
}) {
  /** 病种编码 → AI 建议排序名次 */
  const aiRankMap = useMemo(() => {
    const map = new Map<string, number>();
    (aiReview?.rerank ?? []).forEach((item) => {
      if (item.disease_code && item.ai_rank !== undefined) {
        map.set(item.disease_code, item.ai_rank);
      }
    });
    return map;
  }, [aiReview]);

  return (
    <div className="space-y-5">
      <section className="card card-pad">
        <SectionTitle
          title="匹配批次"
          extra={
            <div className="flex flex-wrap gap-3">
              <BigButton
                variant="secondary"
                disabled={busy || runs.length === 0}
                onClick={() => onAiReview(runs[0].id)}
              >
                AI 复核
              </BigButton>
              <BigButton variant="secondary" disabled={busy} onClick={onRunMatching}>
                重新匹配
              </BigButton>
            </div>
          }
        />
        {runs.length === 0 ? (
          <EmptyState message="暂无匹配记录，可点击「重新匹配」发起一次疾病匹配。" />
        ) : (
          <ul className="space-y-3">
            {runs.map((run) => (
              <li
                key={run.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3"
              >
                <div>
                  <p className="text-elder font-semibold text-ink">批次 {run.id}</p>
                  <p className="text-elder text-ink-soft">
                    运行时间：{formatDateTime(run.created_at)}
                  </p>
                </div>
                <BigButton variant="secondary" onClick={() => onOpenRun(run.id)}>
                  查看候选
                </BigButton>
              </li>
            ))}
          </ul>
        )}
      </section>

      {activeRun ? (
        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-elder-lg font-semibold text-ink">候选疾病与命中依据</h2>
            <BigButton
              disabled={busy}
              onClick={() => onAiReview(activeRun.id)}
            >
              AI 复核
            </BigButton>
          </div>

          {activeRun.alert ? (
            <div className="rounded-xl2 border-2 border-red-300 bg-red-50 p-4">
              <p className="text-elder font-semibold text-red-800">
                就医提醒：{activeRun.alert.message}
              </p>
              {activeRun.alert.department ? (
                <p className="mt-1 text-elder text-red-800">
                  建议就诊科室：{activeRun.alert.department}
                </p>
              ) : null}
              <p className="mt-2 text-elder text-red-800">
                {activeRun.alert.disclaimer ??
                  "结果仅供参考，不构成诊断，请及时咨询医生。"}
              </p>
            </div>
          ) : null}

          <div className="space-y-4">
            {(activeRun.candidates ?? []).map((candidate, index) => (
              <MatchCandidateCard
                key={candidate.disease_code || index}
                candidate={candidate}
                rank={candidate.rank ?? index + 1}
                aiRank={aiRankMap.get(candidate.disease_code)}
                disclaimer={activeRun.disclaimer}
              />
            ))}
          </div>

          {activeRun.candidates?.length ? null : (
            <p className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-elder text-amber-900">
              {activeRun.disclaimer || "结果仅供参考，不构成诊断，请及时咨询医生。"}
            </p>
          )}

          {aiReview ? (
            <AiReviewPanel aiReview={aiReview} candidates={activeRun.candidates ?? []} />
          ) : (
            <p className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-elder text-ink-soft">
              点击「AI 复核」可获得排序建议、追问建议与通俗解释；AI 只给建议，最终由医师裁决。
            </p>
          )}
        </section>
      ) : null}

      <section className="card card-pad">
        <SectionTitle title="就医提醒" />
        {alerts.length === 0 ? (
          <EmptyState message="该患者暂无就医提醒。" />
        ) : (
          <ul className="space-y-4">
            {alerts.map((alert) => (
              <li key={alert.id}>
                <AlertCard
                  alert={alert}
                  handling={busy}
                  onHandle={(action, comment) =>
                    onHandleAlert(alert.id, action, comment)
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card card-pad" id="dialogue">
        <SectionTitle
          title="AI 对话回放"
          extra={
            <BigButton variant="secondary" disabled={busy} onClick={onOpenDialogue}>
              载入对话
            </BigButton>
          }
        />
        {dialogueTurns.length === 0 ? (
          <EmptyState message="点击「载入对话」查看该患者的对话记录。" />
        ) : (
          <ol className="space-y-3">
            {dialogueTurns.map((turn, index) => (
              <li
                key={`${turn.created_at ?? "t"}-${index}`}
                className={[
                  "rounded-xl px-4 py-3 text-elder whitespace-pre-wrap",
                  turn.role === "user"
                    ? "ml-6 bg-medical-700 text-white"
                    : "mr-6 border border-slate-200 bg-slate-50 text-ink",
                ].join(" ")}
              >
                {turn.content}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
