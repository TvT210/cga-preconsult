/**
 * 轻量级全局提示（toast）总线。
 * api.ts 在模块作用域中调用 toast()，ToastProvider 负责订阅并渲染，
 * 这样接口层不依赖 React 运行时。
 */

export type ToastKind = "info" | "success" | "error" | "warning";

export interface ToastItem {
  id: number;
  message: string;
  kind: ToastKind;
}

type Emitter = (item: ToastItem) => void;

let emitter: Emitter | null = null;
let seed = 0;

/** 由 ToastProvider 在挂载时注册，卸载时注销 */
export function registerToastEmitter(fn: Emitter | null): void {
  emitter = fn;
}

export function toast(message: string, kind: ToastKind = "info"): void {
  if (!message) return;
  seed += 1;
  const item: ToastItem = { id: seed, message, kind };
  if (emitter) {
    emitter(item);
  } else {
    // 尚未挂载提示容器时降级为控制台输出，避免静默丢失错误信息
    // eslint-disable-next-line no-console
    console.warn("[提示]", kind, message);
  }
}
