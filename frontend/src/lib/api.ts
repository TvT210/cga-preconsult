import { toast } from "./toast";
import { clearSession, getToken, setToken } from "./session";

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
