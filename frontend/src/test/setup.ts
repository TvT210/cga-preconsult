import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

import { registerToastEmitter } from "@/lib/toast";

/**
 * 测试全局准备（A-6）。
 *
 * 本项目没有开启 vitest `globals`，`describe/it/expect` 一律显式从 "vitest" 引入，
 * 这样 ESLint 与 TypeScript 都不需要额外的全局声明。
 * 代价是 RTL 的自动 cleanup 不会生效，得在这里手动挂。
 */

// 单元测试不挂 ToastProvider，toast() 会退回 console.warn。
// 异常路径本来就是被测对象（如「对话中断」），这里收掉以免淹没真实报错。
registerToastEmitter(() => {});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});
