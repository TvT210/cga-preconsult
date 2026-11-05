import type { Config } from "tailwindcss";

/**
 * 医疗蓝主题 + 适老化尺寸扩展（**老人端 / 线 A**，勿动）。
 * - 正文最小 18pt（text-elder = 18px），行高 1.8
 * - 按钮最小高度 48px（min-h-btn）
 *
 * 医护端（**线 B**）另有��套 token：`clin.*`，见文件末尾「医护端 token」。
 * 两套 token 并存，老人端视觉不受影响。
 */
const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          '"PingFang SC"',
          '"Microsoft YaHei"',
          '"Hiragino Sans GB"',
          "system-ui",
          "-apple-system",
          "sans-serif",
        ],
      },
      fontSize: {
        // 适老化字号阶梯：正文 18px 起
        elder: ["18px", { lineHeight: "1.8" }],
        "elder-lg": ["20px", { lineHeight: "1.7" }],
        "elder-xl": ["22px", { lineHeight: "1.6" }],
        "elder-2xl": ["26px", { lineHeight: "1.5" }],
        // 医护端字号阶梯：正文 14px / 1.6（与适老化阶梯完全独立）
        "clin-xs": ["12px", { lineHeight: "1.5" }],
        "clin-sm": ["13px", { lineHeight: "1.5" }],
        clin: ["14px", { lineHeight: "1.6" }],
        "clin-lg": ["16px", { lineHeight: "1.5" }],
        "clin-title": ["18px", { lineHeight: "1.4" }],
      },
      colors: {
        medical: {
          50: "#eff6ff",
          100: "#dbeafe",
          200: "#bfdbfe",
          300: "#93c5fd",
          400: "#60a5fa",
          500: "#3b82f6",
          600: "#2563eb",
          700: "#1d4ed8",
          800: "#1e40af",
          900: "#1e3a8a",
        },
        ink: {
          DEFAULT: "#1a1a1a",
          soft: "#475569",
          mute: "#64748b",
        },
        elderbg: "#f5f7fa",
        /**
         * 医护端 token（**线 B**）：Slate 中性 + 单一 teal 强调色。
         * 取值与 `globals.css` 中 `.theme-clinical` 作用域的 CSS 变量一一对应，
         * CSS 变量带兜底值，保证在医护端作用域外也能正常解析。
         */
        clin: {
          bg: "var(--c-bg, #ffffff)",
          surface: "var(--c-surface, #ffffff)",
          muted: "var(--c-muted, #f8fafc)",
          border: "var(--c-border, #e2e8f0)",
          "border-strong": "var(--c-border-strong, #cbd5e1)",
          fg: "var(--c-fg, #0f172a)",
          "fg-muted": "var(--c-fg-muted, #64748b)",
          "fg-subtle": "var(--c-fg-subtle, #94a3b8)",
          primary: "var(--c-primary, #0f172a)",
          "primary-hover": "var(--c-primary-hover, #1e293b)",
          accent: "var(--c-accent, #0d9488)",
          "accent-soft": "var(--c-accent-soft, #ccfbf1)",
          danger: "var(--c-danger, #dc2626)",
          warning: "var(--c-warning, #d97706)",
          success: "var(--c-success, #059669)",
        },
      },
      minHeight: {
        btn: "48px",
        "btn-lg": "56px",
      },
      minWidth: {
        btn: "48px",
      },
      borderRadius: {
        xl2: "1rem",
        // 医护端圆角：控件 8px、徽章/输入 6px
        clin: "8px",
        "clin-sm": "6px",
      },
      boxShadow: {
        card: "0 1px 2px rgba(15,23,42,0.06), 0 8px 24px rgba(15,23,42,0.05)",
        // 医护端唯一阴影：仅浮层使用
        "clin-shadow": "0 1px 2px rgba(15,23,42,0.05)",
      },
      keyframes: {
        "fade-in-up": {
          "0%": { opacity: "0", transform: "translateY(6px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "fade-in-up": "fade-in-up 0.24s ease-out both",
      },
    },
  },
  plugins: [],
};

export default config;
