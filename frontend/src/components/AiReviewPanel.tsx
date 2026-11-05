"use client";

import { useMemo, useState } from "react";
import { toast } from "@/lib/toast";
import type { AiReview, MatchCandidate } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ClinSection } from "@/app/staff/_components/clinical";

const CONFIDENCE_LABEL: Record<string, string> = {
  high: "把握较大",
  medium: "把握一般",
  low: "把握较小",
};

const PRIORITY_LABEL: Record<string, string> = {
  high: "优先追问",
  medium: "建议追问",
  low: "可选追问",
};

const PRIORITY_VARIANT: Record<string, "destructive" | "warning" | "secondary"> = {
  high: "destructive",
  medium: "warning",
  low: "secondary",
};

/**
 * AI 语义复核面板（**医护端**）。
 *
 * 红线：AI 只给**建议**，不修改匹配度 / 参考概率 / 阈值 / 提醒等级；
 * 规则排序与 AI 建议排序并列展示，最终由医师裁决。
 */
export function AiReviewPanel({
  aiReview,
  candidates = [],
}: {
  aiReview: AiReview;
  /** 规则排序结果，用于与 AI 建议排序并列对照 */
  candidates?: MatchCandidate[];
}) {
  const [copied, setCopied] = useState("");

  /** 病种编码 → 规则排序名次 */
  const ruleRankMap = useMemo(() => {
    const map = new Map<string, number>();
    candidates.forEach((candidate, index) => {
      map.set(candidate.disease_code, candidate.rank ?? index + 1);
    });
    return map;
  }, [candidates]);

  /** 病种编码 → 疾病名 */
  const diseaseNameMap = useMemo(() => {
    const map = new Map<string, string>();
    candidates.forEach((candidate) => {
      map.set(candidate.disease_code, candidate.disease_name);
    });
    return map;
  }, [candidates]);

  const copyText = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      toast("已复制到剪贴板。", "success");
      window.setTimeout(() => setCopied(""), 2000);
    } catch {
      toast("当前浏览器不支持自动复制，请手动选中文本复制。", "warning");
    }
  };

  const rerank = aiReview.rerank ?? [];
  const followUps = aiReview.follow_ups ?? [];
  const explanations = aiReview.explanations ?? {};
  const disagreements = aiReview.disagreements ?? [];

  return (
    <div className="space-y-6">
      <div className="rounded-clin border border-clin-border bg-clin-muted px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-clin-sm font-medium text-clin-fg">AI 语义复核</h3>
          <div className="flex flex-wrap gap-2 text-clin-xs text-clin-fg-muted">
            {aiReview.model ? <span>模型：{aiReview.model}</span> : null}
            {aiReview.latency_ms !== undefined ? (
              <span>耗时：{aiReview.latency_ms} ms</span>
            ) : null}
          </div>
        </div>
        <p className="mt-1 text-clin-xs text-clin-fg-muted">
          AI 只提供排序建议与补充问诊方向，不修改匹配度、参考概率与提醒等级；
          规则排序与 AI 建议并列展示，<strong>请医师裁决</strong>。
        </p>
      </div>

      {/* ---------------------------- 排序对照 ---------------------------- */}
      <ClinSection title="排序对照：规则引擎 vs AI 建议">
        {rerank.length === 0 ? (
          <p className="text-clin-sm text-clin-fg-subtle">本次复核未给出排序建议。</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[600px] text-left">
              <thead className="border-b border-clin-border bg-clin-muted">
                <tr>
                  <th className="px-3 py-2 text-clin-xs font-medium text-clin-fg-muted">
                    病种
                  </th>
                  <th className="px-3 py-2 text-clin-xs font-medium text-clin-fg-muted">
                    规则排序
                  </th>
                  <th className="px-3 py-2 text-clin-xs font-medium text-clin-fg-muted">
                    AI 建议排序
                  </th>
                  <th className="px-3 py-2 text-clin-xs font-medium text-clin-fg-muted">
                    AI 理由
                  </th>
                  <th className="px-3 py-2 text-clin-xs font-medium text-clin-fg-muted">
                    把握
                  </th>
                </tr>
              </thead>
              <tbody>
                {rerank.map((item, index) => {
                  const ruleRank = ruleRankMap.get(item.disease_code);
                  const moved =
                    ruleRank !== undefined &&
                    item.ai_rank !== undefined &&
                    ruleRank !== item.ai_rank;
                  return (
                    <tr
                      key={`${item.disease_code}-${index}`}
                      className="border-b border-clin-border transition-colors duration-150 last:border-0 hover:bg-clin-muted"
                    >
                      <td className="px-3 py-2 text-clin-sm font-medium text-clin-fg">
                        {item.disease_name ??
                          diseaseNameMap.get(item.disease_code) ??
                          item.disease_code}
                      </td>
                      <td className="px-3 py-2 text-clin-sm tabular-nums text-clin-fg-muted">
                        {ruleRank !== undefined ? `第 ${ruleRank} 位` : "—"}
                      </td>
                      <td className="px-3 py-2 text-clin-sm tabular-nums text-clin-fg">
                        <span className="font-medium">
                          {item.ai_rank !== undefined ? `第 ${item.ai_rank} 位` : "—"}
                        </span>
                        {moved ? (
                          <span className="ml-2">
                            <Badge variant="warning">与规则不一致</Badge>
                          </span>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 text-clin-sm text-clin-fg-muted">
                        {item.rationale ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-clin-sm text-clin-fg-muted">
                        {item.confidence
                          ? (CONFIDENCE_LABEL[item.confidence] ?? item.confidence)
                          : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </ClinSection>

      {/* ---------------------------- 追问建议 ---------------------------- */}
      <ClinSection title="追问建议">
        {followUps.length === 0 ? (
          <p className="text-clin-sm text-clin-fg-subtle">本次复核未给出追问建议。</p>
        ) : (
          <ul className="space-y-3">
            {followUps.map((item, index) => (
              <li
                key={index}
                className="rounded-clin border border-clin-border bg-clin-muted px-4 py-3"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <p className="text-clin-sm font-medium text-clin-fg">
                    {item.question ?? "（未提供问题）"}
                  </p>
                  <div className="flex items-center gap-2">
                    {item.priority ? (
                      <Badge variant={PRIORITY_VARIANT[item.priority] ?? "secondary"}>
                        {PRIORITY_LABEL[item.priority] ?? item.priority}
                      </Badge>
                    ) : null}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        void copyText(item.question ?? "", `follow-${index}`)
                      }
                    >
                      {copied === `follow-${index}` ? "已复制" : "复制"}
                    </Button>
                  </div>
                </div>
                {item.reason ? (
                  <p className="mt-1 text-clin-xs text-clin-fg-muted">
                    原因：{item.reason}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </ClinSection>

      {/* ---------------------------- 通俗解释 ---------------------------- */}
      <ClinSection title="通俗解释（可讲给老人听）">
        {Object.keys(explanations).length === 0 ? (
          <p className="text-clin-sm text-clin-fg-subtle">本次复核未给出通俗解释。</p>
        ) : (
          <ul className="space-y-3">
            {Object.entries(explanations).map(([code, text]) => (
              <li
                key={code}
                className="border-b border-clin-border pb-3 last:border-b-0 last:pb-0"
              >
                <p className="text-clin-sm font-medium text-clin-fg">
                  {diseaseNameMap.get(code) ?? code}
                </p>
                <p className="mt-1 text-clin-sm text-clin-fg-muted">{text}</p>
              </li>
            ))}
          </ul>
        )}
      </ClinSection>

      {/* ---------------------------- 规则与 AI 分歧 ---------------------------- */}
      {disagreements.length > 0 ? (
        <ClinSection title="规则与 AI 判断不一致">
          <ul className="space-y-3">
            {disagreements.map((item, index) => (
              <li
                key={index}
                className="rounded-clin border border-clin-warning px-4 py-3"
              >
                <p className="text-clin-sm font-medium text-clin-fg">
                  {diseaseNameMap.get(item.disease_code ?? "") ??
                    item.disease_code ??
                    "相关病种"}
                </p>
                <p className="mt-1 text-clin-xs text-clin-fg-muted">
                  规则引擎：{item.rule_view ?? "—"}
                </p>
                <p className="mt-0.5 text-clin-xs text-clin-fg-muted">
                  AI 判断：{item.ai_view ?? "—"}
                </p>
                <p className="mt-1 text-clin-xs text-clin-fg">
                  {item.note ? `${item.note} 请医师裁决。` : "规则与语义判断不一致，请医师裁决。"}
                </p>
              </li>
            ))}
          </ul>
        </ClinSection>
      ) : null}

      <p className="rounded-clin border border-clin-warning px-4 py-3 text-clin-sm text-clin-fg">
        {aiReview.notice ?? "AI 复核意见仅供参考，不构成诊断，请以医师判断为准。"}
      </p>
    </div>
  );
}
