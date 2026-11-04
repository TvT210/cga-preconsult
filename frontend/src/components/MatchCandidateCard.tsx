"use client";

import type { MatchCandidate } from "@/lib/types";
import { MATCH_DISCLAIMER } from "./Disclaimer";

const RISK_LABEL: Record<string, string> = {
  immediate: "需立即就医",
  urgent: "需尽快就医",
  elective: "择期就诊",
  observe: "居家观察",
};

function riskLabel(level?: string): string {
  if (!level) return "未分级";
  return RISK_LABEL[level] ?? level;
}

/**
 * 匹配候选卡片。
 * 对外文案一律使用「匹配度」「参考概率」，禁止使用「确诊」「患病」类概率表述。
 */
export function MatchCandidateCard({
  candidate,
  rank,
  disclaimer,
}: {
  candidate: MatchCandidate;
  /** 候选序号，从 1 开始 */
  rank?: number;
  /** 免责声明，默认使用统一口径 */
  disclaimer?: string;
}) {
  const hit = candidate.hit_symptoms ?? [];
  const missing = candidate.missing_symptoms ?? [];
  const excluded = candidate.excluded_reasons ?? [];

  return (
    <article className="rounded-xl2 border border-slate-200 bg-white p-5 shadow-card">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-elder-lg font-semibold text-ink">
            {rank ? `候选 ${rank}：` : ""}
            {candidate.disease_name}
          </h3>
          <p className="mt-1 text-elder text-ink-soft">
            疾病编码：{candidate.disease_code} · 风险等级：{riskLabel(candidate.risk_level)}
          </p>
        </div>
      </header>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="rounded-xl border-2 border-medical-200 bg-medical-50 p-4">
          <p className="text-elder text-medical-900">匹配度</p>
          <p className="mt-1 text-elder-2xl font-bold text-medical-900">
            {candidate.match_score ?? 0}
            <span className="ml-1 text-elder font-medium">分</span>
          </p>
          <div className="mt-2 h-3 w-full overflow-hidden rounded-full bg-white">
            <div
              className="h-full rounded-full bg-medical-700"
              style={{ width: `${Math.max(0, Math.min(100, candidate.match_score ?? 0))}%` }}
            />
          </div>
        </div>

        <div className="rounded-xl border-2 border-slate-300 bg-slate-50 p-4">
          <p className="text-elder text-ink-soft">参考概率</p>
          <p className="mt-1 text-elder-2xl font-bold text-ink">
            {candidate.ref_probability ?? 0}
            <span className="ml-1 text-elder font-medium">分</span>
          </p>
          <div className="mt-2 h-3 w-full overflow-hidden rounded-full bg-white">
            <div
              className="h-full rounded-full bg-slate-500"
              style={{ width: `${Math.max(0, Math.min(100, candidate.ref_probability ?? 0))}%` }}
            />
          </div>
        </div>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-3">
        <div>
          <h4 className="text-elder font-semibold text-ink">命中症状</h4>
          {hit.length ? (
            <ul className="mt-2 space-y-1 text-elder text-ink-soft">
              {hit.map((symptom) => (
                <li key={symptom.code}>
                  · {symptom.term}
                  {symptom.weight !== undefined ? `（权重 ${symptom.weight}）` : ""}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-elder text-ink-mute">暂无</p>
          )}
        </div>

        <div>
          <h4 className="text-elder font-semibold text-ink">缺失关键症状</h4>
          {missing.length ? (
            <ul className="mt-2 space-y-1 text-elder text-ink-soft">
              {missing.map((symptom) => (
                <li key={symptom.code}>· {symptom.term}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-elder text-ink-mute">暂无</p>
          )}
        </div>

        <div>
          <h4 className="text-elder font-semibold text-ink">鉴别排除理由</h4>
          {excluded.length ? (
            <ul className="mt-2 space-y-1 text-elder text-ink-soft">
              {excluded.map((reason, index) => (
                <li key={`${reason}-${index}`}>· {reason}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-elder text-ink-mute">暂无</p>
          )}
        </div>
      </div>

      {candidate.advice ? (
        <p className="mt-4 rounded-xl bg-medical-50 px-4 py-3 text-elder text-medical-900">
          就医建议：{candidate.advice}
        </p>
      ) : null}

      <p className="mt-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-2 text-elder text-amber-900">
        {disclaimer ?? MATCH_DISCLAIMER}
      </p>
    </article>
  );
}
