import type { ProxyInfo } from "./types";

/**
 * 作答来源与主答人（A-5）。
 *
 * 后端同时返回 `responder`（self/proxy/staff）与逐题 `answer_source`，
 * 这里只做展示层的归一与文案，不参与计分、不参与条件求值。
 */

export type AnswerSource = "self" | "proxy" | "staff";

const SOURCE_LABELS: Record<AnswerSource, string> = {
  self: "本人作答",
  proxy: "家属代答",
  staff: "医护代填",
};

/** 未知/缺失一律按「本人作答」处理：旧数据只有 proxy_flag，会由后端补成 self */
export function normalizeSource(source?: string | null): AnswerSource {
  return source === "proxy" || source === "staff" ? source : "self";
}

export function answerSourceLabel(source?: string | null): string {
  return SOURCE_LABELS[normalizeSource(source)];
}

/**
 * 会话主答人。
 *
 * 旧库补列后 `responder` 可能为空，此时按代答人姓名回推——
 * 与后端 `_responder_of` 同一套规则，避免两边对同一份数据给出不同说法。
 */
export function sessionResponder(session: {
  responder?: string | null;
  proxy?: ProxyInfo | null;
}): AnswerSource {
  const raw = (session.responder ?? "").trim();
  if (raw === "proxy" || raw === "staff" || raw === "self") return raw;
  return (session.proxy?.proxy_name ?? "").trim() ? "proxy" : "self";
}

/** 复核页/老人端顶部的代答标识文案 */
export function proxyBadgeText(proxy?: ProxyInfo | null): string {
  const name = (proxy?.proxy_name ?? "").trim();
  const relation = (proxy?.proxy_relation ?? "").trim();
  if (!name) return "家属代答（未填姓名）";
  return relation ? `家属代答：${name}（${relation}）` : `家属代答：${name}`;
}

/**
 * 「代答 N/M 题」。
 *
 * 单独统计是因为复核时真正要看的是**结论里有多少依据来自家属转述**，
 * 而不是「这份问卷是不是代答」这一个是非判断。
 */
export function proxyCountText(proxy?: ProxyInfo | null): string {
  const proxied = Math.max(0, proxy?.proxy_answered ?? 0);
  const self = Math.max(0, proxy?.self_answered ?? 0);
  const total = proxied + self;
  if (!total) return "尚未作答";
  return `代答 ${proxied}/${total} 题`;
}

/** 提交代答前的前置校验：返回 null 表示可以提交 */
export function proxyNameError(responder: AnswerSource, name: string): string | null {
  if (responder !== "proxy") return null;
  return name.trim() ? null : "请先填写代答人姓名，或取消「由家属代答」。";
}
