import { describe, expect, it } from "vitest";

import { filterChineseVoices } from "./speech";

describe("中文人声筛选", () => {
  it("只保留中文音色，英文日文一律不列给老人", () => {
    const voices = filterChineseVoices([
      { name: "Microsoft David", lang: "en-US" },
      { name: "Microsoft Huihui", lang: "zh-CN", localService: true },
      { name: "Kyoko", lang: "ja-JP" },
    ]);
    expect(voices.map((voice) => voice.name)).toEqual(["Microsoft Huihui"]);
  });

  it("同名只留一个（Windows 常同时给出本地与网络版）", () => {
    const voices = filterChineseVoices([
      { name: "Microsoft Xiaoxiao", lang: "zh-CN", localService: false },
      { name: "Microsoft Xiaoxiao", lang: "zh-CN", localService: true },
    ]);
    expect(voices).toHaveLength(1);
  });

  it("本机合成排前，其次普通话，再按名称", () => {
    const voices = filterChineseVoices([
      { name: "B Voice", lang: "zh-TW", localService: false },
      { name: "A Voice", lang: "zh-CN", localService: false },
      { name: "C Voice", lang: "zh-CN", localService: true },
    ]);
    expect(voices.map((voice) => voice.name)).toEqual(["C Voice", "A Voice", "B Voice"]);
  });

  it("缺少 lang 或 name 的脏数据被丢掉", () => {
    const voices = filterChineseVoices([
      { name: "", lang: "zh-CN" },
      { name: "NoLang", lang: "" },
    ]);
    expect(voices).toEqual([]);
  });

  it("空列表不报错（Chrome 首次 getVoices 就是空的）", () => {
    expect(filterChineseVoices([])).toEqual([]);
  });

  it("未标注 localService 时按本机处理（多数浏览器不给该字段）", () => {
    const voices = filterChineseVoices([{ name: "Huihui", lang: "zh-CN" }]);
    expect(voices[0].local).toBe(true);
  });
});
