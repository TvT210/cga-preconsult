import { describe, expect, it } from "vitest";

import {
  DEFAULT_ELDER_PREFS,
  ELDER_PREFS_KEY,
  FONT_SCALES,
  fontScaleLabel,
  nextFontScale,
  normalizeFontScale,
  normalizeRate,
  readElderPrefs,
  stepRate,
  writeElderPrefs,
} from "./elderPrefs";

/** 内存版 Storage：只实现被用到的三个方法，用完即弃 */
function memoryStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, String(value)),
  } as Storage;
}

describe("字号档位", () => {
  it("三档字号与需求一致（18 / 22 / 26）", () => {
    expect(FONT_SCALES.map((item) => item.base)).toEqual([18, 22, 26]);
    expect(FONT_SCALES.map((item) => item.value)).toEqual(["standard", "large", "xlarge"]);
  });

  it("未知值一律回落到标准档", () => {
    expect(normalizeFontScale("huge")).toBe("standard");
    expect(normalizeFontScale(undefined)).toBe("standard");
    expect(normalizeFontScale(null)).toBe("standard");
    expect(normalizeFontScale(22)).toBe("standard");
  });

  it("合法值原样返回", () => {
    expect(normalizeFontScale("large")).toBe("large");
    expect(normalizeFontScale("xlarge")).toBe("xlarge");
  });

  it("循环切换到下一档，特大回到标准", () => {
    expect(nextFontScale("standard")).toBe("large");
    expect(nextFontScale("large")).toBe("xlarge");
    expect(nextFontScale("xlarge")).toBe("standard");
  });

  it("标签用于工具条展示", () => {
    expect(fontScaleLabel("standard")).toBe("标准");
    expect(fontScaleLabel("large")).toBe("大字");
    expect(fontScaleLabel("xlarge")).toBe("特大");
    expect(fontScaleLabel("bogus" as never)).toBe("标准");
  });
});

describe("语速归一", () => {
  it("默认 0.9，超界夹到 0.6~1.2", () => {
    expect(normalizeRate(undefined)).toBe(0.9);
    expect(normalizeRate(0.1)).toBe(0.6);
    expect(normalizeRate(5)).toBe(1.2);
    expect(normalizeRate(-1)).toBe(0.6);
  });

  it("非数字回默认，字符串数字可解析", () => {
    expect(normalizeRate("快了")).toBe(0.9);
    expect(normalizeRate(Number.NaN)).toBe(0.9);
    expect(normalizeRate("1.1")).toBe(1.1);
  });

  it("按 0.1 步进不产生浮点尾巴", () => {
    expect(stepRate(0.7, 0.1)).toBe(0.8);
    expect(stepRate(0.8, 0.1)).toBe(0.9);
    // 0.7 + 0.1 = 0.7999999999999999，必须收敛成 0.8 才能与界面显示一致
    expect(String(stepRate(0.7, 0.1))).toBe("0.8");
  });

  it("到边界再加也不越界", () => {
    expect(stepRate(1.2, 0.1)).toBe(1.2);
    expect(stepRate(0.6, -0.1)).toBe(0.6);
  });
});

describe("读写偏好", () => {
  it("没有存储数据时给默认值", () => {
    expect(readElderPrefs(memoryStorage())).toEqual(DEFAULT_ELDER_PREFS);
  });

  it("写入后能读回同一份", () => {
    const storage = memoryStorage();
    const prefs = { fontScale: "xlarge" as const, rate: 1.1, voiceName: "Microsoft Huihui", autoSpeak: true };
    expect(writeElderPrefs(prefs, storage)).toBe(true);
    expect(readElderPrefs(storage)).toEqual(prefs);
  });

  it("脏 JSON 不抛异常，回落默认值", () => {
    const storage = memoryStorage({ [ELDER_PREFS_KEY]: "{ not json" });
    expect(readElderPrefs(storage)).toEqual(DEFAULT_ELDER_PREFS);
  });

  it("字段类型不对时逐项归一，不整份丢弃", () => {
    const storage = memoryStorage({
      [ELDER_PREFS_KEY]: JSON.stringify({ fontScale: "large", rate: "abc", voiceName: 42, autoSpeak: "yes" }),
    });
    expect(readElderPrefs(storage)).toEqual({
      fontScale: "large",
      rate: 0.9,
      voiceName: "",
      autoSpeak: false,
    });
  });

  it("存储不可用（隐私模式）时读默认、写返回 false，不抛异常", () => {
    const broken = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    } as unknown as Storage;
    expect(readElderPrefs(broken)).toEqual(DEFAULT_ELDER_PREFS);
    expect(writeElderPrefs(DEFAULT_ELDER_PREFS, broken)).toBe(false);
  });

  it("写入时也做归一，不让越界值进存储", () => {
    const storage = memoryStorage();
    writeElderPrefs({ fontScale: "large", rate: 9, voiceName: "", autoSpeak: false }, storage);
    expect(readElderPrefs(storage).rate).toBe(1.2);
  });
});
