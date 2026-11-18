/**
 * 老人端显示偏好（A-9）：字号三档、语音语速、人声、自动朗读。
 *
 * 三条设计约束：
 * 1. **只落本地**（localStorage）：本轮没有账号偏好接口，跨设备同步属账号能力，
 *    在服务端提供之前不假装做到了；
 * 2. **读不炸**：隐私模式 / 禁用存储 / 脏数据都回落到默认值，不能让老人端白屏；
 * 3. **只做归一化**：这里不碰业务数据，也不参与计分与条件求值。
 */

export type FontScale = "standard" | "large" | "xlarge";

export const FONT_SCALES: {
  value: FontScale;
  label: string;
  /** 对应 CSS 里 `--e-fs-base` 的取值，仅用于展示与测试断言 */
  base: number;
  hint: string;
}[] = [
  { value: "standard", label: "标准", base: 18, hint: "正文 18px" },
  { value: "large", label: "大字", base: 22, hint: "正文 22px" },
  { value: "xlarge", label: "特大", base: 26, hint: "正文 26px" },
];

export const RATE_MIN = 0.6;
export const RATE_MAX = 1.2;
export const RATE_STEP = 0.1;
export const RATE_DEFAULT = 0.9;

/** 存储键带版本号：将来改结构时旧数据可整体作废，不必写迁移 */
export const ELDER_PREFS_KEY = "cga_elder_prefs_v1";

export interface ElderPrefs {
  fontScale: FontScale;
  /** 语速，0.6~1.2 */
  rate: number;
  /** 语音合成人声名；空串表示跟随浏览器默认 */
  voiceName: string;
  /** 进入新题目时自动朗读 */
  autoSpeak: boolean;
}

export const DEFAULT_ELDER_PREFS: ElderPrefs = {
  fontScale: "standard",
  rate: RATE_DEFAULT,
  voiceName: "",
  autoSpeak: false,
};

const SCALE_VALUES = FONT_SCALES.map((item) => item.value);

export function normalizeFontScale(raw: unknown): FontScale {
  return SCALE_VALUES.includes(raw as FontScale) ? (raw as FontScale) : "standard";
}

/**
 * 语速归一：非数字回默认，超界夹到 0.6~1.2，保留一位小数。
 * 保留一位是因为界面上按 0.1 步进，浮点累加会出 0.7999999。
 */
export function normalizeRate(raw: unknown): number {
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) return RATE_DEFAULT;
  const clamped = Math.min(RATE_MAX, Math.max(RATE_MIN, value));
  return Number(clamped.toFixed(1));
}

export function stepRate(current: number, delta: number): number {
  return normalizeRate(current + delta);
}

/** 取下一个字号档（循环），供工具条用一个大按钮切换 */
export function nextFontScale(current: FontScale): FontScale {
  const index = SCALE_VALUES.indexOf(normalizeFontScale(current));
  return SCALE_VALUES[(index + 1) % SCALE_VALUES.length];
}

export function fontScaleLabel(scale: FontScale): string {
  return FONT_SCALES.find((item) => item.value === normalizeFontScale(scale))?.label ?? "标准";
}

function asStorage(storage?: Storage | null): Storage | null {
  if (storage) return storage;
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    // Safari 隐私模式下访问 localStorage 会直接抛异常
    return null;
  }
}

/** 读偏好：任何异常与脏字段都回落默认值，只挑认识的键 */
export function readElderPrefs(storage?: Storage | null): ElderPrefs {
  const target = asStorage(storage);
  if (!target) return { ...DEFAULT_ELDER_PREFS };
  try {
    const raw = target.getItem(ELDER_PREFS_KEY);
    if (!raw) return { ...DEFAULT_ELDER_PREFS };
    const parsed = JSON.parse(raw) as Partial<ElderPrefs> | null;
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_ELDER_PREFS };
    return {
      fontScale: normalizeFontScale(parsed.fontScale),
      rate: normalizeRate(parsed.rate),
      voiceName: typeof parsed.voiceName === "string" ? parsed.voiceName : "",
      autoSpeak: parsed.autoSpeak === true,
    };
  } catch {
    return { ...DEFAULT_ELDER_PREFS };
  }
}

/** 写偏好：写失败（配额满 / 无权限）不影响页面继续用 */
export function writeElderPrefs(prefs: ElderPrefs, storage?: Storage | null): boolean {
  const target = asStorage(storage);
  if (!target) return false;
  try {
    target.setItem(
      ELDER_PREFS_KEY,
      JSON.stringify({
        fontScale: normalizeFontScale(prefs.fontScale),
        rate: normalizeRate(prefs.rate),
        voiceName: prefs.voiceName ?? "",
        autoSpeak: prefs.autoSpeak === true,
      }),
    );
    return true;
  } catch {
    return false;
  }
}
