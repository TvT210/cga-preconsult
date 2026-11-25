"use client";

/**
 * 实时通知订阅（WebSocket）。
 *
 * 与后端 `/api/v1/ws/notifications` 对应：
 * 1. 连接建立后先发首帧 `{token}` 完成鉴权（浏览器 WebSocket 不支持自定义头，
 *    把 token 放 URL 会被访问日志记录下来，所以走首帧）；
 * 2. 服务端回 `ready` 后进入在线状态，并每 25 秒发一次 `ping` 保活；
 * 3. 断线后按指数退避重连（1s → 2s → 4s …，上限 30s）。
 *
 * 设计取舍：通知是「锦上添花」，所以任何失败都只降级为静默重连，不弹错误、
 * 不影响页面主流程。
 */

import { useEffect, useRef, useState } from "react";

import { API_BASE } from "./api";
import { toWsUrl } from "./apiBase";
import { getToken } from "./session";

export type RealtimeStatus = "offline" | "connecting" | "online";

export interface RealtimeEvent {
  type: string;
  at?: string;
  data?: Record<string, unknown>;
}

export interface UseRealtimeOptions {
  /** 关掉订阅（例如未登录、或页面不需要实时刷新） */
  enabled?: boolean;
  /** 收到业务事件时回调；ready / pong 等协议帧不会触发 */
  onEvent: (event: RealtimeEvent) => void;
}

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const HEARTBEAT_MS = 25_000;

export function useRealtimeEvents({ enabled = true, onEvent }: UseRealtimeOptions): RealtimeStatus {
  const [status, setStatus] = useState<RealtimeStatus>("offline");

  // 用 ref 保存回调：父组件每次渲染都会生成新函数，若放进依赖会导致反复重连
  const handlerRef = useRef(onEvent);
  useEffect(() => {
    handlerRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") {
      setStatus("offline");
      return;
    }
    const token = getToken();
    if (!token) {
      setStatus("offline");
      return;
    }

    let socket: WebSocket | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    let disposed = false;

    const clearHeartbeat = () => {
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
    };

    const connect = () => {
      if (disposed) return;
      setStatus("connecting");

      let ws: WebSocket;
      try {
        ws = new WebSocket(toWsUrl(API_BASE));
      } catch {
        setStatus("offline");
        return;
      }
      socket = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({ token }));
      };

      ws.onmessage = (raw) => {
        let payload: RealtimeEvent;
        try {
          payload = JSON.parse(String(raw.data)) as RealtimeEvent;
        } catch {
          return;
        }
        if (!payload || typeof payload.type !== "string") return;

        if (payload.type === "ready") {
          attempts = 0;
          setStatus("online");
          clearHeartbeat();
          heartbeat = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "ping" }));
            }
          }, HEARTBEAT_MS);
          return;
        }
        // 协议帧不对外抛
        if (payload.type === "pong" || payload.type === "error") return;
        handlerRef.current(payload);
      };

      ws.onclose = () => {
        clearHeartbeat();
        if (disposed) return;
        setStatus("offline");
        attempts += 1;
        const delay = Math.min(RECONNECT_BASE_MS * 2 ** (attempts - 1), RECONNECT_MAX_MS);
        reconnectTimer = setTimeout(connect, delay);
      };

      ws.onerror = () => {
        // 出错后浏览器会紧跟着触发 onclose，重连逻辑统一放在那里
        try {
          ws.close();
        } catch {
          /* 忽略 */
        }
      };
    };

    connect();

    return () => {
      disposed = true;
      clearHeartbeat();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try {
        socket?.close();
      } catch {
        /* 忽略 */
      }
    };
  }, [enabled]);

  return status;
}
