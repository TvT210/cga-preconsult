"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { registerToastEmitter, type ToastItem, type ToastKind } from "@/lib/toast";

const ToastContext = createContext<(message: string, kind?: ToastKind) => void>(
  () => undefined,
);

/** 供业务组件手动弹出提示 */
export function useToast() {
  return useContext(ToastContext);
}

const KIND_STYLE: Record<ToastKind, string> = {
  info: "border-medical-200 bg-white text-ink",
  success: "border-emerald-300 bg-emerald-50 text-emerald-900",
  warning: "border-amber-300 bg-amber-50 text-amber-900",
  error: "border-red-300 bg-red-50 text-red-900",
};

/** 全局提示容器，需挂在根布局中 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    const emit = (item: ToastItem) => {
      setItems((prev) => {
        // 同一句话不重复弹出，避免并行请求失败时刷屏
        if (prev.some((existing) => existing.message === item.message)) return prev;
        return [...prev, item].slice(-4);
      });
      window.setTimeout(() => {
        setItems((prev) => prev.filter((i) => i.id !== item.id));
      }, 4200);
    };
    registerToastEmitter(emit);
    return () => registerToastEmitter(null);
  }, []);

  const notify = useCallback((message: string, kind: ToastKind = "info") => {
    setItems((prev) => [
      ...prev,
      { id: Date.now() + Math.random(), message, kind },
    ].slice(-4));
  }, []);

  return (
    <ToastContext.Provider value={notify}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-0 top-3 z-50 flex flex-col items-center gap-2 px-4"
        role="status"
        aria-live="polite"
      >
        {items.map((item) => (
          <div
            key={item.id}
            className={`pointer-events-auto w-full max-w-xl rounded-xl border-2 px-5 py-3 text-elder shadow-lg ${KIND_STYLE[item.kind]}`}
          >
            {item.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
