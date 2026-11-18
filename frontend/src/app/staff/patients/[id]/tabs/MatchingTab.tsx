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
import { MatchCandidateCard } from "@/components/MatchCandidateCard";
import { Button } from "@/components/ui/button";
import { groupConflicts } from "@/lib/conflicts";
import { ClinEmpty, ClinSection } from "@/app/staff/_components/clinical";

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

  /**
   * 冲突标记是逐轮检出的，同一处矛盾会在多轮里重复出现。
   * 先摊平再按类别去重，复核时看到的是「有几件事要核对」，不是「检出过几次」。
   */
  const conflictGroups = useMemo(
    () => groupConflicts(dialogueTurns.flatMap((turn) => turn.conflict_flags ?? [])),
    [dialogueTurns],
  );
  const conflictCount = useMemo(
    () => conflictGroups.reduce((total, group) => total + group.items.length, 0),
    [conflictGroups],
  );

  return (
    <div>
      <ClinSection
        title="匹配批次"
        extra={
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={busy || runs.length === 0}
              onClick={() => onAiReview(runs[0].id)}
            >
              AI 复核
            </Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={onRunMatching}>
              重新匹配
            </Button>
          </div>
        }
      >
        {runs.length === 0 ? (
          <ClinEmpty message="暂无匹配记录，可点击「重新匹配」发起一次疾病匹配。" />
        ) : (
          <ul className="divide-y divide-clin-border border-y border-clin-border">
            {runs.map((run) => (
              <li
                key={run.id}
                className="flex flex-wrap items-center justify-between gap-3 py-2.5"
              >
                <div>
                  <p className="text-clin-sm font-medium text-clin-fg">批次 {run.id}</p>
                  <p className="mt-0.5 text-clin-xs text-clin-fg-muted">
                    运行时间：{formatDateTime(run.created_at)}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onOpenRun(run.id)}
                >
                  查看候选
                </Button>
              </li>
            ))}
          </ul>
        )}
      </ClinSection>

      {activeRun ? (
        <ClinSection
          title="候选疾病与命中依据"
          extra={
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => onAiReview(activeRun.id)}
            >
              AI 复核
            </Button>
          }
        >
          {activeRun.alert ? (
            <div className="mb-4 rounded-clin border border-clin-danger px-4 py-3">
              <p className="text-clin-sm font-medium text-clin-danger">
                就医提醒：{activeRun.alert.message}
              </p>
              {activeRun.alert.department ? (
                <p className="mt-1 text-clin-xs text-clin-danger">
                  建议就诊科室：{activeRun.alert.department}
                </p>
              ) : null}
              <p className="mt-1 text-clin-xs text-clin-danger">
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
            <p className="rounded-clin border border-clin-warning px-4 py-3 text-clin-sm text-clin-fg">
              {activeRun.disclaimer || "结果仅供参考，不构成诊断，请及时咨询医生。"}
            </p>
          )}

          {aiReview ? (
            <AiReviewPanel aiReview={aiReview} candidates={activeRun.candidates ?? []} />
          ) : (
            <p className="rounded-clin border border-clin-border bg-clin-muted px-4 py-3 text-clin-sm text-clin-fg-muted">
              点击「AI 复核」可获得排序建议、追问建议与通俗解释；AI 只给建议，最终由医师裁决。
            </p>
          )}
        </ClinSection>
      ) : null}

      <ClinSection title="就医提醒">
        {alerts.length === 0 ? (
          <ClinEmpty message="该患者暂无就医提醒。" />
        ) : (
          <div className="space-y-4">
            {alerts.map((alert) => (
              <AlertCard
                key={alert.id}
                alert={alert}
                handling={busy}
                onHandle={(action, comment) =>
                  onHandleAlert(alert.id, action, comment)
                }
              />
            ))}
          </div>
        )}
      </ClinSection>

      <ClinSection
        title="信息冲突"
        extra={
          conflictGroups.length ? (
            <span className="text-clin-xs text-clin-fg-muted">
              共 {conflictCount} 条 · 只提示不修改
            </span>
          ) : null
        }
      >
        {conflictGroups.length === 0 ? (
          <ClinEmpty message="未发现对话与量表／画像记录不一致的地方。" />
        ) : (
          <div className="space-y-3">
            {conflictGroups.map((group) => (
              <div
                key={group.kind}
                className={[
                  "rounded-clin border px-4 py-3",
                  group.warn ? "border-clin-warning" : "border-clin-border",
                ].join(" ")}
              >
                <p className="text-clin-sm font-medium text-clin-fg">
                  {group.label}
                  <span className="ml-2 text-clin-xs text-clin-fg-muted">
                    {group.items.length} 条
                  </span>
                </p>
                <ul className="mt-1.5 space-y-1.5">
                  {group.items.map((flag, index) => (
                    <li
                      key={`${group.kind}-${index}`}
                      className="text-clin-xs text-clin-fg-muted"
                    >
                      <span className="text-clin-fg">{flag.note || group.label}</span>
                      {flag.evidence ? (
                        <span className="ml-1">原句：「{flag.evidence}」</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            <p className="text-clin-xs text-clin-fg-muted">
              冲突只标记不覆盖：量表结果、画像记录与计分均未被改动，请按原记录核对后人工更正。
            </p>
          </div>
        )}
      </ClinSection>

      <ClinSection
        title="AI 对话回放"
        extra={
          <Button variant="outline" size="sm" disabled={busy} onClick={onOpenDialogue}>
            载入对话
          </Button>
        }
      >
        {dialogueTurns.length === 0 ? (
          <ClinEmpty message="点击「载入对话」查看该患者的对话记录。" />
        ) : (
          <ol className="space-y-3">
            {dialogueTurns.map((turn, index) => (
              <li
                key={`${turn.created_at ?? "t"}-${index}`}
                className={[
                  "whitespace-pre-wrap rounded-clin px-4 py-3 text-clin-sm",
                  turn.role === "user"
                    ? "ml-6 bg-clin-primary text-white"
                    : "mr-6 border border-clin-border bg-clin-muted text-clin-fg",
                ].join(" ")}
              >
                {turn.content}
              </li>
            ))}
          </ol>
        )}
      </ClinSection>
    </div>
  );
}
