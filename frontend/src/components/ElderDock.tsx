"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import type { AssistanceRequest, ElderSupport } from "@/lib/types";
import { BigButton } from "./BigButton";
import { FontScaleSwitch } from "./ElderPrefs";
import { useToast } from "./Toast";

interface AssistContextValue {
  /** 当前题目所在的会话与题目编码，供求助时带上「在哪一题卡住」 */
  setAssistContext: (next: { sessionId?: number; questionCode?: string } | null) => void;
}

const AssistContext = createContext<AssistContextValue>({ setAssistContext: () => undefined });

/** 量表页用它登记当前题，吸底条即可带上题目上下文 */
export function useAssistContext() {
  return useContext(AssistContext);
}

/**
 * 老人端吸底常驻条（A-9）。
 *
 * 两件事：**字号三档**与**一键呼叫工作人员**。放在 layout 里，因此每一页都够得着，
 * 不需要老人退回到某一页才能改字号或求助。
 *
 * 「呼叫」是真落库的请求（`/elder/assistance`），不是弹个提示框就完事：
 * 老人能看到「已通知」与时间，医护端能认领并标记已处理。
 */
export function ElderDock() {
  const toast = useToast();
  const [context, setContext] = useState<{ sessionId?: number; questionCode?: string } | null>(
    null,
  );
  const [open, setOpen] = useState(false);
  const [support, setSupport] = useState<ElderSupport | null>(null);
  const [pending, setPending] = useState<AssistanceRequest | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [sentAt, setSentAt] = useState("");
  const dockRef = useRef<HTMLDivElement | null>(null);

  const setAssistContext = useCallback((next: { sessionId?: number; questionCode?: string } | null) => {
    setContext(next);
  }, []);

  const value = useMemo<AssistContextValue>(() => ({ setAssistContext }), [setAssistContext]);

  /** 打开面板时拉一次求助方式与「有没有还没人来的呼叫」 */
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [supportData, pendingList] = await Promise.all([
        api.get<ElderSupport>("/elder/support", {}, { silent: true }),
        api.get<AssistanceRequest[]>("/elder/assistance", { status: "pending", limit: 5 }, { silent: true }),
      ]);
      setSupport(supportData);
      setPending(Array.isArray(pendingList) && pendingList.length ? pendingList[0] : null);
    } catch {
      // 求助信息拿不到不阻断使用：面板会退化成「请到护士站找人帮忙」
      setSupport(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open, refresh]);

  /**
   * 把吸底条实际高度写回主题元素。
   *
   * 固定写一个 padding 值不靠谱：特大字号 + 360px 窄屏时按钮会折成两行，
   * 吸底条从 88px 涨到 160px，正文最后一段就被压在条下面。
   * 用 ResizeObserver 实测高度，`main` 的 padding-bottom 跟着走。
   */
  useEffect(() => {
    const el = dockRef.current;
    if (!el) return;
    const host = el.closest(".elder-theme") as HTMLElement | null;
    if (!host) return;
    const apply = () => host.style.setProperty("--e-dock-h", `${el.offsetHeight}px`);
    apply();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const sendRequest = useCallback(async () => {
    setSending(true);
    try {
      const created = await api.post<AssistanceRequest>("/elder/assistance", {
        ...(context?.sessionId ? { session_id: context.sessionId } : {}),
        ...(context?.questionCode ? { question_code: context.questionCode } : {}),
      });
      setPending(created);
      setSentAt(formatDateTime(created.created_at));
      toast("已通知工作人员，请在原地稍等。", "success");
    } catch {
      /* 错误提示已由 api 层统一处理 */
    } finally {
      setSending(false);
    }
  }, [context, toast]);

  return (
    <AssistContext.Provider value={value}>
      {/* 吸底条：打印时隐藏（见 globals.css 的 @media print） */}
      <div
        ref={dockRef}
        className="elder-dock fixed inset-x-0 bottom-0 z-40 border-t-2 border-slate-200 bg-white/95 backdrop-blur"
      >
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-3 py-2">
          <FontScaleSwitch />
          <BigButton variant="warning" size="md" onClick={() => setOpen(true)}>
            呼叫工作人员
          </BigButton>
        </div>
      </div>

      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 px-4 pb-4 sm:items-center"
          role="dialog"
          aria-modal="true"
          aria-label="呼叫工作人员"
        >
          <div className="card card-pad w-full max-w-xl space-y-4">
            <h2 className="text-elder-2xl font-bold text-ink">需要人来帮忙吗？</h2>

            {loading ? (
              <p className="text-elder text-ink-soft">正在读取求助方式…</p>
            ) : (
              <>
                <p className="text-elder text-ink">
                  {support?.note ?? "点下面的按钮通知工作人员；也可以直接到护士站找人帮忙。"}
                </p>

                {support?.phone ? (
                  <a
                    href={`tel:${support.phone}`}
                    className="flex min-h-btn-lg items-center justify-center rounded-xl border-2 border-medical-700 bg-medical-50 px-4 text-elder-lg font-semibold text-medical-800"
                  >
                    直接打电话：{support.phone}
                  </a>
                ) : null}
                {support?.hours ? (
                  <p className="text-elder text-ink-soft">有人接听的时间：{support.hours}</p>
                ) : null}

                {pending ? (
                  <p className="rounded-xl border-2 border-amber-300 bg-amber-50 px-4 py-3 text-elder text-amber-900">
                    {sentAt || formatDateTime(pending.created_at)} 已经呼叫过一次，工作人员还没到。
                    不用着急，可以再叫一次。
                  </p>
                ) : null}

                <div className="space-y-3">
                  <BigButton
                    variant="warning"
                    size="xl"
                    fullWidth
                    loading={sending}
                    onClick={() => void sendRequest()}
                  >
                    {pending ? "再叫一次" : "现在就叫工作人员"}
                  </BigButton>
                  <BigButton
                    variant="ghost"
                    size="lg"
                    fullWidth
                    onClick={() => setOpen(false)}
                  >
                    先不用，我自己试试
                  </BigButton>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}
    </AssistContext.Provider>
  );
}
