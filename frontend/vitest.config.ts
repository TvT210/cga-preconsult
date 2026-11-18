import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * 前端单元测试配置（A-6）。
 *
 * - 只收集 `src` 下与被测代码同目录的 `*.test.ts(x)`，不涉及端到端；
 * - 统一用 `jsdom`：组件测试需要 DOM，纯逻辑测试跑在 jsdom 里也无副作用，
 *   不必为两类测试维护两套环境；
 * - `@/` 别名与 `tsconfig.json` 的 `paths` 对齐，测试可直接沿用源码写法。
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    // 每个用例后还原 spy/stub，避免 fetch 之类的全局桩泄漏到下一条用例
    restoreMocks: true,
  },
});
