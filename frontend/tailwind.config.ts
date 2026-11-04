import type { Config } from "tailwindcss";

/**
 * 医疗蓝主题 + 适老化尺寸扩展。
 * - 正文最小 18pt（text-elder = 18px），行高 1.8
 * - 按钮最小高度 48px（min-h-btn）
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
      },
      boxShadow: {
        card: "0 1px 2px rgba(15,23,42,0.06), 0 8px 24px rgba(15,23,42,0.05)",
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
