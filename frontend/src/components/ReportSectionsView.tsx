"use client";

import { MatchCandidateCard } from "./MatchCandidateCard";
import { Disclaimer } from "./Disclaimer";
import type { MatchRunDetail, ReportSections, ScaleScore } from "@/lib/types";

/** 字段中文名映射，避免直接暴露英文键名 */
const KEY_LABEL: Record<string, string> = {
  name: "名称",
  title: "标题",
  text: "内容",
  content: "内容",
  value: "数值",
  total: "总分",
  score: "得分",
  level: "等级",
  interpretation: "判读结论",
  conclusion: "结论",
  severity: "严重程度",
  abnormal: "是否异常",
  flags: "阳性项",
  explanation: "判读说明",
  rule_refs: "规则依据",
  dimension: "维度",
  item: "项目",
  need_special: "需专项评估",
  note: "备注",
  interval_days: "复评周期（天）",
  focus_items: "重点跟踪项",
  due_at: "到期时间",
  model: "模型",
  prompt_version: "提示词版本",
  generated_at: "生成时间",
  notice: "说明",
  trend: "趋势",
  dimension_conclusions: "维度结论",
};

function labelFor(key: string): string {
  return KEY_LABEL[key] ?? key;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renderScalar(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (Array.isArray(value)) {
    return value
      .map((item) =>
        isRecord(item)
          ? String(item.name ?? item.term ?? item.text ?? JSON.stringify(item))
          : String(item),
      )
      .join("、");
  }
  if (isRecord(value)) return JSON.stringify(value);
  return String(value);
}

/** 通用对象卡片：逐字段展示 */
function ObjectCard({ data }: { data: Record<string, unknown> }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {Object.entries(data).map(([key, value]) => (
          <div key={key} className="flex flex-wrap gap-2">
            <dt className="text-elder font-medium text-ink-soft">{labelFor(key)}</dt>
            <dd className="text-elder text-ink">{renderScalar(value)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function GenericList({ items }: { items: unknown[] }) {
  return (
    <ul className="space-y-3">
      {items.map((item, index) => {
        if (isRecord(item)) {
          return <li key={index}><ObjectCard data={item} /></li>;
        }
        return (
          <li
            key={index}
            className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-elder text-ink"
          >
            {renderScalar(item)}
          </li>
        );
      })}
    </ul>
  );
}

function isScaleScore(item: unknown): item is ScaleScore {
  return isRecord(item) && "level" in item && "total" in item;
}

function ScaleScoreCard({ score }: { score: ScaleScore }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h4 className="text-elder font-semibold text-ink">
          {score.scale_code} · {score.level}
        </h4>
        <span className="rounded-full bg-medical-100 px-3 py-1 text-elder font-semibold text-medical-800">
          总分 {score.total}
        </span>
        {score.abnormal ? (
          <span className="rounded-full bg-amber-100 px-3 py-1 text-elder text-amber-900">
            异常
          </span>
        ) : null}
      </div>
      {score.interpretation ? (
        <p className="mt-2 text-elder text-ink">{score.interpretation}</p>
      ) : null}
      {score.explanation ? (
        <p className="mt-1 text-elder text-ink-soft">{score.explanation}</p>
      ) : null}
      {score.flags && score.flags.length ? (
        <p className="mt-2 text-elder text-amber-800">阳性项：{score.flags.join("、")}</p>
      ) : null}
      {score.rule_refs && score.rule_refs.length ? (
        <p className="mt-1 text-elder text-ink-soft">
          规则依据：{score.rule_refs.join("、")}
        </p>
      ) : null}
    </div>
  );
}

function Block({
  title,
  clinical = false,
  children,
}: {
  title: string;
  /** 医护端模式：用 1px 上边框分块，取代老人端的 .card .card-pad 堆叠 */
  clinical?: boolean;
  children: React.ReactNode;
}) {
  if (clinical) {
    return (
      <section className="clin-section">
        <h3 className="clin-section-title mb-4">{title}</h3>
        {children}
      </section>
    );
  }
  return (
    <section className="card card-pad">
      <h3 className="mb-3 text-elder-lg font-semibold text-ink">{title}</h3>
      {children}
    </section>
  );
}

/**
 * 报告内容渲染。老人端与医护端共用，确保口径一致。
 *
 * `clinical` 只影响**外层分块样式**（医护端用 1px 上边框而非卡片堆叠），
 * 老人端默认走原有 `.card .card-pad`，渲染结果与改动前完全一致。
 */
export function ReportSectionsView({
  sections,
  disclaimer,
  clinical = false,
}: {
  sections: ReportSections;
  disclaimer?: string;
  /** 医护端简洁风格开关 */
  clinical?: boolean;
}) {
  const scaleResults = (sections.scale_results ?? []) as unknown[];
  const dimensionSummary = (sections.dimension_summary ?? []) as unknown[];
  const positiveList = (sections.positive_list ?? []) as unknown[];
  const interventions = (sections.interventions ?? []) as unknown[];
  const mdtOpinions = (sections.mdt_opinions ?? []) as unknown[];
  const match = sections.disease_match as MatchRunDetail | undefined;

  return (
    <div className="space-y-5">
      {sections.basic && Object.keys(sections.basic).length ? (
        <Block title="基本信息">
          <ObjectCard data={sections.basic} />
        </Block>
      ) : null}

      {scaleResults.length ? (
        <Block title="量表结果">
          <ul className="space-y-3">
            {scaleResults.map((item, index) =>
              isScaleScore(item) ? (
                <li key={index}>
                  <ScaleScoreCard score={item} />
                </li>
              ) : (
                <li key={index}>
                  <ObjectCard data={isRecord(item) ? item : { 内容: item }} />
                </li>
              ),
            )}
          </ul>
        </Block>
      ) : null}

      {dimensionSummary.length ? (
        <Block title="维度小结">
          <GenericList items={dimensionSummary} />
        </Block>
      ) : null}

      {positiveList.length ? (
        <Block title="阳性问题清单">
          <GenericList items={positiveList} />
        </Block>
      ) : null}

      {sections.ai_supplement && Object.keys(sections.ai_supplement).length ? (
        <Block title="AI 补充评估">
          <ObjectCard data={sections.ai_supplement} />
          <p className="mt-3 rounded-xl bg-slate-100 px-4 py-2 text-elder text-ink-soft">
            AI 补充评估，不替代正式量表施测。
          </p>
        </Block>
      ) : null}

      {match && Array.isArray(match.candidates) && match.candidates.length ? (
        <Block title="疾病匹配">
          <div className="space-y-4">
            {match.candidates.map((candidate, index) => (
              <MatchCandidateCard
                key={candidate.disease_code || index}
                candidate={candidate}
                rank={index + 1}
                disclaimer={match.disclaimer ?? disclaimer}
              />
            ))}
          </div>
        </Block>
      ) : null}

      {interventions.length ? (
        <Block title="干预建议">
          <GenericList items={interventions} />
        </Block>
      ) : null}

      {mdtOpinions.length ? (
        <Block title="多学科意见">
          <GenericList items={mdtOpinions} />
        </Block>
      ) : null}

      {sections.followup_plan && Object.keys(sections.followup_plan).length ? (
        <Block title="随访计划">
          <ObjectCard data={sections.followup_plan} />
        </Block>
      ) : null}

      <Disclaimer text={disclaimer} />
    </div>
  );
}
