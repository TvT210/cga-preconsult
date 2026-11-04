"use client";

import type { MatchCandidate, MatchEvidenceItem } from "@/lib/types";
import { MATCH_DISCLAIMER } from "./Disclaimer";

const RISK_LABEL: Record<string, string> = {
  immediate: "需立即就医",
  urgent: "需尽快就医",
  elective: "择期就诊",
  observe: "居家观察",
};

const WEIGHT_LABEL: Record<string, string> = {
  core: "核心症状",
  secondary: "次要症状",
  history: "病史命中",
  pattern: "症状组合",
};

function riskLabel(level?: string): string {
  if (!level) return "未分级";
  return RISK_LABEL[level] ?? level;
}

function weightLabel(weight?: number | string): string {
  if (weight === undefined || weight === null) return "";
  if (typeof weight === "number") return `权重 ${weight}`;
  return WEIGHT_LABEL[weight] ?? String(weight);
}

/** 区分性症状：只命中本候选，是支持本病的关键线索 */
function DistinctiveList({ items }: { items: MatchEvidenceItem[] }) {
  return (
    <ul className="mt-2 space-y-2">
      {items.map((item, index) => (
        <li
          key={`${item.code ?? "d"}-${index}`}
          className="rounded-lg border-l-4 border-medical-700 bg-medical-50 px-3 py-2"
        >
          <p className="text-elder font-semibold text-medical-900">
            {item.term ?? item.code}
            {item.weight ? (
              <span className="ml-2 text-sm font-normal text-medical-700">
                {weightLabel(item.weight)}
              </span>
            ) : null}
          </p>
          <p className="mt-1 text-sm text-medical-800">
            {item.note ?? "仅本候选命中，是支持本病的关键线索"}
            {item.distinctive !== undefined
              ? `（区分度系数 ${item.distinctive}）`
              : ""}
          </p>
        </li>
      ))}
    </ul>
  );
}

/** 共享症状：多个候选同时命中，区分度低 */
function SharedList({ items }: { items: MatchEvidenceItem[] }) {
  return (
    <ul className="mt-2 space-y-2">
      {items.map((item, index) => (
        <li
          key={`${item.code ?? "s"}-${index}`}
          className="rounded-lg border-l-4 border-slate-300 bg-slate-50 px-3 py-2"
        >
          <p className="text-elder text-ink-soft">
            {item.term ?? item.code}
            {item.shared_with && item.shared_with.length ? (
              <span className="ml-2 text-sm text-ink-mute">
                另见候选：{item.shared_with.join("、")}
              </span>
            ) : null}
          </p>
          <p className="mt-1 text-sm text-ink-mute">
            {item.note ?? "多个候选都有，区分度低"}
          </p>
        </li>
      ))}
    </ul>
  );
}

/**
 * 匹配候选卡片。
 *
 * 三层信息分层展示：**规则排序**（rank）、**AI 建议排序**（aiRank）、
 * **命中依据**（区分性症状用强调色，共享症状用弱化色）。
 *
 * 对外文案一律使用「匹配度」「参考概率」，禁止使用「确诊」「患病」类概率表述。
 */
export function MatchCandidateCard({
  candidate,
  rank,
  aiRank,
  disclaimer,
}: {
  candidate: MatchCandidate;
  /** 规则引擎给出的候选序号，从 1 开始 */
  rank?: number;
  /** AI 语义复核给出的建议序号 */
  aiRank?: number;
  /** 免责声明，默认使用统一口径 */
  disclaimer?: string;
}) {
  const hit = candidate.hit_symptoms ?? [];
  const missing = candidate.missing_symptoms ?? [];
  const excluded = candidate.excluded_reasons ?? [];
  const distinctive = candidate.distinctive_symptoms ?? [];
  const shared = candidate.shared_symptoms ?? [];
  const patterns = candidate.pattern_hits ?? [];
  const redFlags = candidate.red_flags ?? [];
  const protective = candidate.protective_signs ?? [];

  // 区分性 / 共享症状已在候选里有独立字段，其余命中症状单独列出
  const distinctiveCodes = new Set(distinctive.map((item) => item.code));
  const sharedCodes = new Set(shared.map((item) => item.code));
  const others = hit.filter(
    (item) =>
      !distinctiveCodes.has(item.code) && !sharedCodes.has(item.code),
  );

  const adviceText =
    typeof candidate.advice === "string" ? candidate.advice : candidate.advice?.text;
  const adviceDepartment =
    typeof candidate.advice === "object" ? candidate.advice?.department : undefined;
  const adviceUrgency =
    typeof candidate.advice === "object" ? candidate.advice?.urgency : undefined;

  const rankConflict =
    rank !== undefined && aiRank !== undefined && rank !== aiRank;

  return (
    <article
      className={[
        "rounded-xl2 border bg-white p-5 shadow-card",
        candidate.evidence_insufficient ? "border-slate-200 opacity-80" : "border-slate-200",
      ].join(" ")}
    >
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
        <div className="flex flex-wrap items-center gap-2">
          {rank !== undefined ? (
            <span className="rounded-full border-2 border-medical-700 bg-medical-50 px-3 py-1 text-elder font-semibold text-medical-800">
              规则排序 第 {rank} 位
            </span>
          ) : null}
          {aiRank !== undefined ? (
            <span
              className={[
                "rounded-full border-2 px-3 py-1 text-elder font-semibold",
                rankConflict
                  ? "border-amber-400 bg-amber-50 text-amber-900"
                  : "border-slate-300 bg-slate-50 text-ink-soft",
              ].join(" ")}
            >
              AI 建议排序 第 {aiRank} 位
            </span>
          ) : null}
        </div>
      </header>

      {rankConflict ? (
        <p className="mt-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-2 text-elder text-amber-900">
          规则排序与 AI 建议排序不一致，请医师裁决后再向患者说明。
        </p>
      ) : null}

      {candidate.evidence_insufficient ? (
        <p className="mt-3 rounded-xl border border-slate-300 bg-slate-100 px-4 py-2 text-elder text-ink-soft">
          证据不足，本候选为补位展示，参考价值有限。
        </p>
      ) : null}

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
              style={{
                width: `${Math.max(0, Math.min(100, candidate.match_score ?? 0))}%`,
              }}
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
              style={{
                width: `${Math.max(0, Math.min(100, candidate.ref_probability ?? 0))}%`,
              }}
            />
          </div>
        </div>
      </div>

      {/* ---------------------------- 红旗征 ---------------------------- */}
      {redFlags.length > 0 ? (
        <section className="mt-4 rounded-xl2 border-2 border-red-500 bg-red-50 p-4">
          <p className="text-elder font-bold text-red-800">
            急症红旗征命中（{redFlags.length} 项）
          </p>
          <ul className="mt-2 space-y-1 text-elder text-red-800">
            {redFlags.map((flag, index) => (
              <li key={`${flag.code ?? "rf"}-${index}`}>
                · {flag.term ?? flag.code}
                {flag.note ? ` —— ${flag.note}` : ""}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-elder font-semibold text-red-800">
            红旗征命中时提醒等级不得下调，请优先安排就医。
          </p>
        </section>
      ) : null}

      {/* ---------------------------- 命中依据 ---------------------------- */}
      <div className="mt-5 space-y-4">
        <section>
          <h4 className="text-elder font-semibold text-ink">
            区分性症状（只命中本候选）
          </h4>
          {distinctive.length ? (
            <DistinctiveList items={distinctive} />
          ) : (
            <p className="mt-2 text-elder text-ink-mute">暂无</p>
          )}
        </section>

        <section>
          <h4 className="text-elder font-semibold text-ink">
            共享症状（多个候选都有，区分度低）
          </h4>
          {shared.length ? (
            <SharedList items={shared} />
          ) : (
            <p className="mt-2 text-elder text-ink-mute">暂无</p>
          )}
        </section>

        {others.length > 0 ? (
          <section>
            <h4 className="text-elder font-semibold text-ink">其余命中症状</h4>
            <ul className="mt-2 space-y-1 text-elder text-ink-soft">
              {others.map((symptom, index) => (
                <li key={`${symptom.code}-${index}`}>
                  · {symptom.term}
                  {symptom.weight !== undefined
                    ? `（${weightLabel(symptom.weight)}）`
                    : ""}
                  {symptom.points !== undefined ? ` +${symptom.points} 分` : ""}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {patterns.length > 0 ? (
          <section className="rounded-xl border-2 border-medical-200 bg-medical-50 p-4">
            <h4 className="text-elder font-semibold text-medical-900">
              症状组合命中（{patterns.length} 组）
            </h4>
            <ul className="mt-2 space-y-2 text-elder text-medical-900">
              {patterns.map((pattern, index) => (
                <li key={`${pattern.code ?? "p"}-${index}`}>
                  · {pattern.term ?? pattern.code}
                  {pattern.points !== undefined ? `（+${pattern.points} 分）` : ""}
                  {pattern.symptoms && pattern.symptoms.length ? (
                    <span className="ml-2 text-sm text-medical-800">
                      组成症状：{pattern.symptoms.join("、")}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {protective.length > 0 ? (
          <section>
            <h4 className="text-elder font-semibold text-ink">保护性征象</h4>
            <ul className="mt-2 space-y-1 text-elder text-ink-soft">
              {protective.map((item, index) => (
                <li key={`${item.code ?? "p"}-${index}`}>
                  · {item.term ?? item.code}
                  {item.note ? ` —— ${item.note}` : ""}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {candidate.risk_factor_hits && candidate.risk_factor_hits.length > 0 ? (
          <section>
            <h4 className="text-elder font-semibold text-ink">已具备的高危因素</h4>
            <ul className="mt-2 space-y-1 text-elder text-ink-soft">
              {candidate.risk_factor_hits.map((item, index) => (
                <li key={`${item.factor ?? "f"}-${index}`}>
                  · {item.factor}
                  {item.detail ? `：${item.detail}` : ""}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {candidate.risk_factors && candidate.risk_factors.length > 0 ? (
          <section>
            <h4 className="text-elder font-semibold text-ink">
              该病高危因素清单（医护阅读用）
            </h4>
            <ul className="mt-2 space-y-1 text-elder text-ink-soft">
              {candidate.risk_factors.map((item, index) => (
                <li key={`${item.factor ?? "f"}-${index}`}>
                  · {item.factor}
                  {item.detail ? `：${item.detail}` : ""}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>

      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <section>
          <h4 className="text-elder font-semibold text-ink">缺失关键症状</h4>
          {missing.length ? (
            <ul className="mt-2 space-y-1 text-elder text-ink-soft">
              {missing.map((symptom, index) => (
                <li key={`${symptom.code}-${index}`}>
                  · {symptom.term}
                  {symptom.weight ? `（${weightLabel(symptom.weight)}）` : ""}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-elder text-ink-mute">暂无</p>
          )}
        </section>

        <section>
          <h4 className="text-elder font-semibold text-ink">鉴别排除理由</h4>
          {excluded.length ? (
            <ul className="mt-2 space-y-1 text-elder text-ink-soft">
              {excluded.map((reason, index) => {
                const text =
                  typeof reason === "string" ? reason : (reason.reason ?? "—");
                const vs =
                  typeof reason === "string" ? undefined : reason.vs_code;
                const points =
                  typeof reason === "string" ? undefined : reason.points;
                return (
                  <li key={`${text}-${index}`}>
                    · {text}
                    {vs ? `（相较 ${vs}）` : ""}
                    {points !== undefined ? ` 扣 ${Math.abs(points)} 分` : ""}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="mt-2 text-elder text-ink-mute">暂无</p>
          )}
        </section>
      </div>

      {adviceText ? (
        <div className="mt-4 rounded-xl bg-medical-50 px-4 py-3 text-elder text-medical-900">
          <p className="font-semibold">
            就医建议
            {adviceUrgency ? `：${adviceUrgency}` : ""}
          </p>
          <p className="mt-1">{adviceText}</p>
          {adviceDepartment ? (
            <p className="mt-1">建议就诊科室：{adviceDepartment}</p>
          ) : null}
        </div>
      ) : null}

      <p className="mt-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-2 text-elder text-amber-900">
        {disclaimer ?? MATCH_DISCLAIMER}
      </p>
    </article>
  );
}
