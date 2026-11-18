/**
 * 评审凭据的展示口径（A-1）。
 *
 * 凭据分级不是装饰：它决定判读结论是否还带「签字件待补」的提示。
 * 所以文案必须说明后果，不能只写一个「口头确认」的标签——
 * 录入的人需要知道，勾这一项会让 21 张量表在判读时继续标为需人工确认。
 */

export type EvidenceType = "signed_document" | "in_system" | "verbal_confirmation";

export interface EvidenceOption {
  value: EvidenceType;
  label: string;
  /** 该凭据的含义与后果，直接展示给录入的人 */
  hint: string;
}

export const EVIDENCE_OPTIONS: EvidenceOption[] = [
  {
    value: "signed_document",
    label: "签字件（纸质／扫描）",
    hint: "有签字原件时选这项；判读结论不再附「签字件待补」提示。",
  },
  {
    value: "in_system",
    label: "系统内审批（本人账号）",
    hint: "评审人本人登录后自己点；签字人默认取当前账号。",
  },
  {
    value: "verbal_confirmation",
    label: "口头／线上确认",
    hint: "无签字件时选这项，必须写明依据；判读结论会保留「签字件待补」提示。",
  },
];

const LABELS: Record<string, string> = {
  signed_document: "签字件",
  in_system: "系统内审批",
  verbal_confirmation: "口头确认",
};

export function evidenceLabel(value?: string | null): string {
  const key = (value ?? "").trim();
  if (!key) return "凭据未记录";
  return LABELS[key] ?? key;
}

/** 口头或线上确认都没有书面凭据，需要一个显式提示。 */
export function evidenceNeedsSignedDocument(value?: string | null): boolean {
  const key = (value ?? "").trim();
  return Boolean(key) && key !== "signed_document";
}

/** 凭据不足时给录入人的提醒；凭据充足返回空串。 */
export function evidenceWarning(value?: string | null): string {
  if (!evidenceNeedsSignedDocument(value)) return "";
  return "选定凭据不是签字件：量表可进入已评审状态，但判读结论会继续标注「签字件待补」，正式出具前需医护确认。";
}

/** 一句摘要，表格里用；缺信息时如实说明缺什么，不拼成半截话。 */
export function evidenceSummary(
  reviewer?: string | null,
  title?: string | null,
  evidence?: string | null,
  reviewedAt?: string | null,
): string {
  if (!evidence && !reviewer) return "—";
  const parts: string[] = [];
  if (reviewer) parts.push(title ? `${reviewer}（${title}）` : reviewer);
  if (evidence) parts.push(evidenceLabel(evidence));
  if (reviewedAt) parts.push(reviewedAt.slice(0, 10));
  return parts.length ? parts.join(" · ") : "—";
}
