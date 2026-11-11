import { toast } from "./toast";
import { clearSession, getToken, setToken } from "./session";
import type {
  AlertItem,
  AssessmentListItem,
  DialogueReply,
  DiseaseListResponse,
  KnowledgeGraph,
  KnowledgeOverview,
  MatchRunDetail,
  MatchRunListItem,
  Paged,
  Patient,
  QualityMetrics,
  ScaleStatBucket,
  StatsOverview,
  SymptomDetail,
} from "./types";

/**
 * 后端接口统一封装。
 * - 基础地址：NEXT_PUBLIC_API_BASE，默认 http://127.0.0.1:8000/api/v1
 * - 自动附加 Authorization: Bearer <token>（token 存 localStorage）
 * - 401 自动清理登录态并跳转登录页
 * - 响应统一解包 {code, message, data}，code != 0 抛错并 toast
 */

export const API_BASE = (
  process.env.NEXT_PUBLIC_API_BASE ?? "http://127.0.0.1:8000/api/v1"
).replace(/\/+$/, "");

export class ApiError extends Error {
  code: number;
  status: number;

  constructor(message: string, code = -1, status = 0) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

export type QueryValue = string | number | boolean | undefined | null;

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  query?: Record<string, QueryValue>;
  /** 401 时是否跳转登录页，默认 true；登录接口传 false */
  redirectOn401?: boolean;
  /** 是否对错误弹 toast，默认 true */
  silent?: boolean;
}

function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  let url = `${API_BASE}${path}`;
  if (!query) return url;
  const params = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    params.append(key, String(value));
  });
  const qs = params.toString();
  if (qs) url += (url.includes("?") ? "&" : "?") + qs;
  return url;
}

export async function request<T = unknown>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const { method = "GET", body, query, redirectOn401 = true, silent = false } = options;

  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(buildUrl(path, query), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    const error = new ApiError("网络连接失败，请检查网络后重试。", -1, 0);
    if (!silent) toast(error.message, "error");
    throw error;
  }

  if (response.status === 401) {
    clearSession();
    if (redirectOn401 && typeof window !== "undefined") {
      const current = window.location.pathname;
      if (current !== "/login") {
        window.location.href = `/login?redirect=${encodeURIComponent(current)}`;
      }
    }
    const error = new ApiError("登录状态已失效，请重新登录。", 401, 401);
    if (!silent) toast(error.message, "warning");
    throw error;
  }

  const raw = await response.text();
  let payload: { code?: number; message?: string; data?: unknown } | null = null;
  if (raw) {
    try {
      payload = JSON.parse(raw) as { code?: number; message?: string; data?: unknown };
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const message = payload?.message || `请求失败（HTTP ${response.status}）。`;
    const error = new ApiError(message, payload?.code ?? response.status, response.status);
    if (!silent) toast(error.message, "error");
    throw error;
  }

  if (!payload) {
    const error = new ApiError("服务器返回的数据格式无法识别。", -1, response.status);
    if (!silent) toast(error.message, "error");
    throw error;
  }

  if (payload.code !== undefined && payload.code !== 0) {
    const error = new ApiError(payload.message || "操作失败。", payload.code, response.status);
    if (!silent) toast(error.message, "error");
    throw error;
  }

  return payload.data as T;
}

export const api = {
  get<T = unknown>(path: string, query?: Record<string, QueryValue>): Promise<T> {
    return request<T>(path, { method: "GET", query });
  },
  post<T = unknown>(path: string, body?: unknown): Promise<T> {
    return request<T>(path, { method: "POST", body });
  },
  put<T = unknown>(path: string, body?: unknown): Promise<T> {
    return request<T>(path, { method: "PUT", body });
  },
  delete<T = unknown>(path: string): Promise<T> {
    return request<T>(path, { method: "DELETE" });
  },
};

/** 登录接口使用：保存 token */
export function persistToken(token: string): void {
  setToken(token);
}

/* ------------------------------------------------------------------ */
/* 对话流式（A-7）                                                     */
/* ------------------------------------------------------------------ */

export interface DialogueStreamHandlers {
  /** 正文增量；调用方自行拼接，不要当完整句子用 */
  onDelta?: (text: string) => void;
  /** 急症安全提示。它可能早于任何正文到达，调用方应立即醒目展示 */
  onSafety?: (note: string) => void;
  /** 收尾：字段与非流式接口一致 */
  onDone?: (payload: DialogueReply) => void;
}

/** SSE 事件分隔：一个空行。兼容 CRLF（有些代理会插入 \r） */
const SSE_SEPARATOR = /\r?\n\r?\n/;

/** 取出一个 SSE 事件块里所有 `data:` 行并拼成 JSON 文本 */
function readSseData(block: string): string {
  return block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
}

/**
 * 流式发送一轮对话。
 *
 * - 收尾事件返回的字段与非流式 `POST /messages` 完全一致，前端可直接复用同一套处理；
 * - **主动中断返回 `null`**，不抛错——「老人点了停止」是正常操作，不该弹错误提示；
 * - 流断开但没收到收尾事件时报错，绝不把半截回复当成完整结果。
 *
 * 没有在这里做「打字机」节流：真实模型的 chunk 本身就带间隔，按到达即渲染最自然；
 * 再叠一层定时器只会在网络抖动时让文字落后于服务端。
 */
export async function streamDialogueMessage(
  sessionId: string | number,
  content: string,
  handlers: DialogueStreamHandlers = {},
  signal?: AbortSignal,
): Promise<DialogueReply | null> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(
      buildUrl(`/dialogue/sessions/${sessionId}/messages/stream`),
      {
        method: "POST",
        headers,
        body: JSON.stringify({ content }),
        cache: "no-store",
        signal,
      },
    );
  } catch (err) {
    if (signal?.aborted) return null;
    const error = new ApiError("网络连接失败，请检查网络后重试。", -1, 0);
    toast(error.message, "error");
    throw error;
  }

  if (response.status === 401) {
    clearSession();
    if (typeof window !== "undefined" && window.location.pathname !== "/login") {
      window.location.href = `/login?redirect=${encodeURIComponent(window.location.pathname)}`;
    }
    throw new ApiError("登录状态已失效，请重新登录。", 401, 401);
  }

  if (!response.ok || !response.body) {
    const raw = await response.text().catch(() => "");
    let message = `请求失败（HTTP ${response.status}）。`;
    try {
      const payload = JSON.parse(raw) as { message?: string };
      if (payload?.message) message = payload.message;
    } catch {
      /* 错误体不是 JSON，用状态码兜底 */
    }
    const error = new ApiError(message, response.status, response.status);
    toast(error.message, "error");
    throw error;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let final: DialogueReply | null = null;

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      for (;;) {
        const match = SSE_SEPARATOR.exec(buffer);
        if (!match || match.index === undefined) break;
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);

        const data = readSseData(block);
        if (!data) continue;
        let event: (DialogueReply & { done?: boolean }) | null = null;
        try {
          event = JSON.parse(data) as DialogueReply & { done?: boolean };
        } catch {
          continue; // 心跳或注释行
        }
        if (event?.done) {
          final = event;
          handlers.onDone?.(event);
        } else if (typeof event?.reply === "string" && event.reply) {
          handlers.onDelta?.(event.reply);
        } else if (event?.safety_note) {
          handlers.onSafety?.(event.safety_note);
        }
      }
    }
  } catch (err) {
    if (signal?.aborted) return null;
    throw err;
  }

  if (!final) {
    if (signal?.aborted) return null;
    const error = new ApiError("对话中断，请稍后重试。", -1, 0);
    toast(error.message, "error");
    throw error;
  }
  return final;
}

/* ------------------------------------------------------------------ */
/* 质控指标：管理员接口 + 权限降级路径                                  */
/* ------------------------------------------------------------------ */

/**
 * 质控数据获取结果。
 * - `degraded = false`：直接来自 `GET /admin/quality-metrics`（管理员账号）。
 * - `degraded = true`：管理员接口返回 403，已改用公开接口自行聚合，
 *   此时 `unavailable` 里列出的指标前端需要标注「需管理员权限」。
 */
export interface QualityMetricsResult {
  metrics: QualityMetrics;
  degraded: boolean;
  /** 降级模式下无法获得的指标键 */
  unavailable: string[];
  /** 降级说明，直接展示在页面上 */
  degradedNote?: string;
}

/** 列表接口的两种返回形态统一取数组 */
function toItems<T>(payload: T[] | Paged<T> | null | undefined): T[] {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  return payload.items ?? [];
}

/** 计算比例，分母为 0 时返回 null（表示暂无数据，不编造 0） */
function ratio(numerator: number, denominator: number): number | null {
  if (!denominator) return null;
  return Math.round((numerator / denominator) * 10000) / 10000;
}

/** 计算均值，空数组返回 null */
function mean(values: number[]): number | null {
  if (!values.length) return null;
  const sum = values.reduce((acc, item) => acc + item, 0);
  return Math.round((sum / values.length) * 100) / 100;
}

/** 降级聚合时最多覆盖多少位患者的评估明细 */
const FALLBACK_PATIENT_LIMIT = 20;
/** 降级聚合时最多解析多少个匹配批次 */
const FALLBACK_RUN_LIMIT = 20;

/**
 * 质控指标的降级聚合：管理员接口 403 时，用医护角色可访问的公开接口自行计算。
 *
 * 可计算：评估完成率 / 复核率 / 异常检出率 / 待确认率 / 量表分布 /
 *         提醒响应率 / 高等级提醒占比 / Top1 匹配度均值 / Top1-Top2 差值 /
 *         AI 复核覆盖率 / 疾病库覆盖率。
 * 不可计算：计分一致率（需复核改分明细）、误报率（提醒列表未返回误报标记）、
 *         匹配准确率与召回率（需人工标注集）。
 */
async function aggregateQualityMetrics(): Promise<QualityMetricsResult> {
  const unavailable: string[] = [];

  const [statsResult, patientsResult, alertsResult, runsResult, diseasesResult] =
    await Promise.allSettled([
      request<StatsOverview>("/admin/stats/overview", { silent: true }),
      request<Patient[] | Paged<Patient>>("/patients", {
        query: { size: 100 },
        silent: true,
      }),
      request<AlertItem[] | Paged<AlertItem>>("/alerts", { silent: true }),
      request<MatchRunListItem[] | Paged<MatchRunListItem>>("/matching/runs", {
        silent: true,
      }),
      request<DiseaseListResponse>("/diseases", { silent: true }),
    ]);

  const stats =
    statsResult.status === "fulfilled" ? (statsResult.value ?? {}) : ({} as StatsOverview);
  const patients =
    patientsResult.status === "fulfilled" ? toItems(patientsResult.value) : [];
  const alerts = alertsResult.status === "fulfilled" ? toItems(alertsResult.value) : [];
  const runs = runsResult.status === "fulfilled" ? toItems(runsResult.value) : [];
  const diseases =
    diseasesResult.status === "fulfilled" ? (diseasesResult.value?.diseases ?? []) : [];

  // ---- 评估明细：逐患者拉取（受限于降级聚合上限）----
  const scopedPatients = patients.slice(0, FALLBACK_PATIENT_LIMIT);
  const perPatient = await Promise.allSettled(
    scopedPatients.map((patient) =>
      request<AssessmentListItem[] | Paged<AssessmentListItem>>(
        `/patients/${patient.id}/assessments`,
        { silent: true },
      ),
    ),
  );
  const sessions: AssessmentListItem[] = [];
  perPatient.forEach((item) => {
    if (item.status === "fulfilled") sessions.push(...toItems(item.value));
  });

  const scored = sessions.filter((item) => Boolean(item.score));
  const finished = sessions.filter(
    (item) => item.status === "finished" || item.status === "reviewed",
  );
  const reviewed = sessions.filter((item) => item.status === "reviewed");
  const abnormal = scored.filter((item) => item.score?.abnormal);
  const pending = scored.filter(
    (item) => item.score?.needs_manual_review && item.status !== "reviewed",
  );

  const scaleStats: Record<string, ScaleStatBucket> = {};
  sessions.forEach((item) => {
    const bucket = scaleStats[item.scale_code] ?? { total: 0, abnormal: 0, pending: 0 };
    bucket.total = (bucket.total ?? 0) + 1;
    if (item.score?.abnormal) bucket.abnormal = (bucket.abnormal ?? 0) + 1;
    if (item.score?.needs_manual_review && item.status !== "reviewed") {
      bucket.pending = (bucket.pending ?? 0) + 1;
    }
    scaleStats[item.scale_code] = bucket;
  });

  // ---- 提醒闭环 ----
  const handled = alerts.filter((item) =>
    ["ack", "closed", "escalate", "escalated"].includes(item.status ?? ""),
  ).length;
  const escalated = alerts.filter((item) =>
    ["escalate", "escalated"].includes(item.status ?? ""),
  ).length;
  const triggered = alerts.filter(
    (item) => item.level === "immediate" || item.level === "urgent",
  ).length;

  // ---- 匹配效果：逐批次取候选 ----
  const runDetails = await Promise.allSettled(
    runs.slice(0, FALLBACK_RUN_LIMIT).map((run) =>
      request<MatchRunDetail>(`/matching/runs/${run.id}`, { silent: true }),
    ),
  );
  const topScores: number[] = [];
  const gaps: number[] = [];
  const hitDiseases = new Set<string>();
  runDetails.forEach((item) => {
    if (item.status !== "fulfilled") return;
    const candidates = [...(item.value?.candidates ?? [])].sort(
      (left, right) => (left.rank ?? 0) - (right.rank ?? 0),
    );
    if (candidates.length) topScores.push(candidates[0].match_score ?? 0);
    if (candidates.length > 1) {
      gaps.push(
        Math.round(((candidates[0].match_score ?? 0) - (candidates[1].match_score ?? 0)) * 100) /
          100,
      );
    }
    candidates.forEach((candidate) => {
      if (candidate.disease_code) hitDiseases.add(candidate.disease_code);
    });
  });

  const totalRuns = Number(stats.match_runs ?? runs.length) || runs.length;
  const aiReviews = Number(stats.ai_reviews ?? 0);

  const metrics: QualityMetrics = {
    assessment_completion_rate: ratio(finished.length, sessions.length),
    review_rate: ratio(reviewed.length, scored.length),
    abnormal_detection_rate: ratio(abnormal.length, scored.length),
    pending_confirmation_rate: ratio(pending.length, scored.length),
    // 复核改分明细不公开，降级模式无法计算
    scoring_consistency: null,
    scoring_consistency_samples: 0,
    alert_response_rate: ratio(handled, alerts.length),
    alert_escalation_rate: ratio(escalated, alerts.length),
    high_level_alert_ratio: ratio(triggered, alerts.length),
    // 提醒列表未返回误报标记，降级模式无法计算
    false_alert_rate: null,
    false_alert_samples: 0,
    match_accuracy: null,
    match_recall: null,
    top1_match_score_avg: mean(topScores),
    top1_top2_gap_avg: mean(gaps),
    ai_review_coverage: ratio(aiReviews, totalRuns),
    disease_library_coverage: ratio(hitDiseases.size, diseases.length),
    disease_library_size: diseases.length,
    disease_hit_count: hitDiseases.size,
    scale_stats: scaleStats,
    stats: stats as unknown as Record<string, unknown>,
    note: "降级模式：由公开接口自行聚合，部分指标口径与管理员接口略有差异。",
  };

  unavailable.push("scoring_consistency", "false_alert_rate");

  return {
    metrics,
    degraded: true,
    unavailable,
    degradedNote:
      "当前账号无质控接口权限（管理员专用），以下指标由公开接口自行聚合，计分一致率与误报率需管理员权限。",
  };
}

/**
 * 拉取质控指标。
 * 优先走管理员接口 `GET /admin/quality-metrics`；
 * 医护（staff/doctor）账号会拿到 403，此时自动降级为公开接口聚合结果。
 */
export async function fetchQualityMetrics(): Promise<QualityMetricsResult> {
  try {
    const metrics = await request<QualityMetrics>("/admin/quality-metrics", {
      silent: true,
    });
    return { metrics: metrics ?? {}, degraded: false, unavailable: [] };
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 403) throw err;
    return aggregateQualityMetrics();
  }
}

/** 单个匹配批次的 Top1 匹配度与 Top1-Top2 差值（趋势图数据点） */
export interface MatchScorePoint {
  runId: string | number;
  createdAt?: string;
  /** Top1 候选的匹配度 */
  top1: number;
  /** Top1 与 Top2 的匹配度差值，批次只有 1 个候选时为 null */
  gap: number | null;
  diseaseName?: string;
}

/**
 * 拉取匹配批次的 Top1 趋势序列。
 * 管理员质控接口只提供均值，画趋势图需要逐批次数据，故单独取。
 */
export async function fetchMatchScoreSeries(
  limit = 20,
): Promise<MatchScorePoint[]> {
  const runs = await request<MatchRunListItem[] | Paged<MatchRunListItem>>(
    "/matching/runs",
    { silent: true },
  );
  const list = toItems(runs).slice(0, limit);
  const details = await Promise.allSettled(
    list.map((run) => request<MatchRunDetail>(`/matching/runs/${run.id}`, { silent: true })),
  );

  const points: MatchScorePoint[] = [];
  details.forEach((item, index) => {
    if (item.status !== "fulfilled") return;
    const run = list[index];
    const candidates = [...(item.value?.candidates ?? [])].sort(
      (left, right) => (left.rank ?? 0) - (right.rank ?? 0),
    );
    if (!candidates.length) return;
    const top1 = candidates[0].match_score ?? 0;
    points.push({
      runId: run.id,
      createdAt: run.created_at,
      top1,
      gap:
        candidates.length > 1
          ? Math.round(((top1 - (candidates[1].match_score ?? 0)) * 100)) / 100
          : null,
      diseaseName: candidates[0].disease_name,
    });
  });

  // 按运行时间从早到晚排列，折线图时间轴才正确
  return points.reverse();
}

/**
 * 下载报告文件（Word / PDF）。
 * 导出接口需要 Authorization 头，不能直接用浏览器地址栏跳转，故在此处带令牌取回二进制。
 */export async function downloadReportFile(
  reportId: string | number,
  format: "docx" | "pdf",
  fileName: string,
): Promise<void> {
  if (typeof document === "undefined") return;

  const headers: Record<string, string> = { Accept: "*/*" };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(
    buildUrl(`/reports/${reportId}/export`, { format }),
    { headers, cache: "no-store" },
  );

  if (!response.ok) {
    const error = new ApiError("报告导出失败，请稍后重试。", response.status, response.status);
    toast(error.message, "error");
    throw error;
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

/* ------------------------------------------------------------------ */
/* 知识库可视化（医护端 · 线 B）                                       */
/* ------------------------------------------------------------------ */

/** 图谱查询参数 */
export interface KnowledgeGraphParams {
  /** 按类型过滤：disease / symptom / scale，留空为全部 */
  node_type?: string;
  /** 按名称或编码过滤节点 */
  keyword?: string;
}

/**
 * 拉取知识库关系图谱（节点 + 边）。
 * 后端返回的数据来自待医学评审的草稿，页面必须展示 `notice` 免责提示。
 */
export async function getKnowledgeGraph(
  params?: KnowledgeGraphParams,
): Promise<KnowledgeGraph> {
  const graph = await request<KnowledgeGraph>("/knowledge/graph", {
    query: {
      node_type: params?.node_type || undefined,
      keyword: params?.keyword || undefined,
    },
    silent: true,
  });
  return graph ?? { nodes: [], edges: [] };
}

/** 拉取单个症状详情：同义词、鉴别问法、关联病种与可加测量表 */
export async function getSymptomDetail(code: string): Promise<SymptomDetail> {
  const detail = await request<SymptomDetail>(
    `/knowledge/symptoms/${encodeURIComponent(code)}`,
    { silent: true },
  );
  return detail;
}

/** 拉取知识库概览：规模与覆盖度统计 */
export async function getKnowledgeOverview(): Promise<KnowledgeOverview> {
  const overview = await request<KnowledgeOverview>("/knowledge/overview", {
    silent: true,
  });
  return overview ?? {};
}
