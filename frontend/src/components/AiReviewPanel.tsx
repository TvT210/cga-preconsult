"use client";

import { useMemo, useState } from "react";
import { toast } from "@/lib/toast";
import type { AiReview, MatchCandidate } from "@/lib/types";
import { StatusBadge } from "@/components/StatusBadge";

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

const PRIORITY_TONE: Record<string, "red" | "amber" | "gray"> = {
  high: "red",
  medium: "amber",
  low: "gray",
};

/**
 * AI 语义复核面板。
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
    <div className="space-y-5">
      <section className="rounded-xl2 border-2 border-medical-200 bg-medical-50 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-elder-lg font-semibold text-medical-900">AI 语义复核</h3>
          <div className="flex flex-wrap gap-2 text-sm text-medical-900">
            {aiReview.model ? <span>模型：{aiReview.model}</span> : null}
            {aiReview.latency_ms !== undefined ? (
              <span>耗时：{aiReview.latency_ms} ms</span>
            ) : null}
          </div>
        </div>
        <p className="mt-2 text-elder text-medical-900">
          AI 只提供排序建议与补充问诊方向，不修改匹配度、参考概率与提醒等级；
          规则排序与 AI 建议并列展示，<strong>请医师裁决</strong>。
        </p>
      </section>

      {/* ---------------------------- 排序对照 ---------------------------- */}
      <section className="card overflow-hidden">
        <div className="card-pad pb-0">
          <h4 className="section-title">排序对照：规则引擎 vs AI 建议</h4>
        </div>
        {rerank.length === 0 ? (
          <div className="card-pad">
            <p className="text-elder text-ink-mute">本次复核未给出排序建议。</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left">
              <thead className="border-b border-slate-200 bg-slate-50">
                <tr>
                  <th className="px-5 py-3 text-elder font-semibold text-ink">病种</th>
                  <th className="px-5 py-3 text-elder font-semibold text-ink">规则排序</th>
                  <th className="px-5 py-3 text-elder font-semibold text-ink">AI 建议排序</th>
                  <th className="px-5 py-3 text-elder font-semibold text-ink">AI 理由</th>
                  <th className="px-5 py-3 text-elder font-semibold text-ink">把握</th>
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
                      className="border-b border-slate-100 last:border-0"
                    >
                      <td className="px-5 py-3 text-elder font-semibold text-ink">
                        {item.disease_name ??
                          diseaseNameMap.get(item.disease_code) ??
                          item.disease_code}
                      </td>
                      <td className="px-5 py-3 text-elder text-ink-soft">
                        {ruleRank !== undefined ? `第 ${ruleRank} 位` : "—"}
                      </td>
                      <td className="px-5 py-3 text-elder text-ink">
                        <span className="font-semibold">
                          {item.ai_rank !== undefined ? `第 ${item.ai_rank} 位` : "—"}
                        </span>
                        {moved ? (
                          <span className="ml-2">
                            <StatusBadge label="与规则不一致" tone="amber" />
                          </span>
                        ) : null}
                      </td>
                      <td className="px-5 py-3 text-elder text-ink-soft">
                        {item.rationale ?? "—"}
                      </td>
                      <td className="px-5 py-3 text-elder text-ink-soft">
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
      </section>

      {/* ---------------------------- 追问建议 ---------------------------- */}
      <section className="card card-pad">
        <h4 className="section-title">追问建议</h4>
        {followUps.length === 0 ? (
          <p className="mt-2 text-elder text-ink-mute">本次复核未给出追问建议。</p>
        ) : (
          <ul className="mt-3 space-y-3">
            {followUps.map((item, index) => (
              <li
                key={`${item.question ?? "q"}-${index}`}
                className="rounded-xl border-2 border-medical-200 bg-medical-50 p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <p className="text-elder font-semibold text-medical-900">
                    {item.question ?? "（未提供问题）"}
                  </p>
                  <div className="flex items-center gap-2">
                    {item.priority ? (
                      <StatusBadge
                        label={PRIORITY_LABEL[item.priority] ?? item.priority}
                        tone={PRIORITY_TONE[item.priority] ?? "gray"}
                      />
                    ) : null}
                    <button
                      type="button"
                      onClick={() =>
                        void copyText(item.question ?? "", `follow-${index}`)
                      }
                      className="rounded-lg border-2 border-medical-700 px-3 py-1 text-sm font-semibold text-medical-700 hover:bg-medical-50"
                    >
                      {copied === `follow-${index}` ? "已复制" : "复制"}
                    </button>
                  </div>
                </div>
                {item.reason ? (
                  <p className="mt-2 text-elder text-medical-900">
                    原因：{item.reason}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ---------------------------- 通俗解释 ---------------------------- */}
      <section className="card card-pad">
        <h4 className="section-title">通俗解释（可讲给老人听）</h4>
        {Object.keys(explanations).length === 0 ? (
          <p className="mt-2 text-elder text-ink-mute">本次复核未给出通俗解释。</p>
        ) : (
          <ul className="mt-3 space-y-3">
            {Object.entries(explanations).map(([code, text]) => (
              <li
                key={code}
                className="rounded-xl border border-slate-200 bg-slate-50 p-4"
              >
                <p className="text-elder font-semibold text-ink">
                  {diseaseNameMap.get(code) ?? code}
                </p>
                <p className="mt-2 text-elder text-ink-soft">{text}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ---------------------------- 规则与 AI 分歧 ---------------------------- */}
      {disagreements.length > 0 ? (
        <section className="rounded-xl2 border-2 border-amber-300 bg-amber-50 p-4">
          <h4 className="text-elder-lg font-semibold text-amber-900">
            规则与 AI 判断不一致
          </h4>
          <ul className="mt-3 space-y-3">
            {disagreements.map((item, index) => (
              <li
                key={`${item.disease_code ?? "d"}-${index}`}
                className="rounded-xl border border-amber-300 bg-white p-4"
              >
                <p className="text-elder font-semibold text-ink">
                  {diseaseNameMap.get(item.disease_code ?? "") ??
                    item.disease_code ??
                    "相关病种"}
                </p>
                <p className="mt-2 text-elder text-ink-soft">
                  规则引擎：{item.rule_view ?? "—"}
                </p>
                <p className="mt-1 text-elder text-ink-soft">
                  AI 判断：{item.ai_view ?? "—"}
                </p>
                {item.note ? (
                  <p className="mt-2 text-elder font-medium text-amber-900">
                    {item.note} 请医师裁决。
                  </p>
                ) : (
                  <p className="mt-2 text-elder font-medium text-amber-900">
                    规则与语义判断不一致，请医师裁决。
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <p className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-elder text-amber-900">
        {aiReview.notice ?? "AI 复核意见仅供参考，不构成诊断，请以医师判断为准。"}
      </p>
    </div>
  );
}
