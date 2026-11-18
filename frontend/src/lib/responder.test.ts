import { describe, expect, it } from "vitest";
import {
  answerSourceLabel,
  normalizeSource,
  proxyBadgeText,
  proxyCountText,
  proxyNameError,
  sessionResponder,
} from "./responder";

describe("normalizeSource", () => {
  it("识别 proxy 与 staff", () => {
    expect(normalizeSource("proxy")).toBe("proxy");
    expect(normalizeSource("staff")).toBe("staff");
  });

  it("缺失或未知值回退为本人作答（旧数据只有 proxy_flag）", () => {
    expect(normalizeSource(undefined)).toBe("self");
    expect(normalizeSource(null)).toBe("self");
    expect(normalizeSource("")).toBe("self");
    expect(normalizeSource("PROXY")).toBe("self");
  });
});

describe("answerSourceLabel", () => {
  it("给出中文来源说明", () => {
    expect(answerSourceLabel("self")).toBe("本人作答");
    expect(answerSourceLabel("proxy")).toBe("家属代答");
    expect(answerSourceLabel("staff")).toBe("医护代填");
  });
});

describe("sessionResponder", () => {
  it("优先使用后端 responder", () => {
    expect(sessionResponder({ responder: "proxy", proxy: { proxy_name: "李小雨" } })).toBe("proxy");
    expect(sessionResponder({ responder: "self", proxy: { proxy_name: "李小雨" } })).toBe("self");
  });

  it("responder 缺失时按代答人姓名回推（与后端 _responder_of 同规则）", () => {
    expect(sessionResponder({ proxy: { proxy_name: "李小雨" } })).toBe("proxy");
    expect(sessionResponder({ proxy: { proxy_name: "   " } })).toBe("self");
    expect(sessionResponder({ proxy: { is_proxy: true } })).toBe("self");
    expect(sessionResponder({})).toBe("self");
  });
});

describe("proxyBadgeText", () => {
  it("带关系时补全括号", () => {
    expect(proxyBadgeText({ proxy_name: "李小雨", proxy_relation: "女儿" })).toBe(
      "家属代答：李小雨（女儿）",
    );
  });

  it("没有关系只显示姓名", () => {
    expect(proxyBadgeText({ proxy_name: "李小雨" })).toBe("家属代答：李小雨");
  });

  it("没有姓名时明确说未填，而不是空字符串", () => {
    expect(proxyBadgeText({ proxy_name: "  " })).toBe("家属代答（未填姓名）");
    expect(proxyBadgeText(null)).toBe("家属代答（未填姓名）");
  });
});

describe("proxyCountText", () => {
  it("混合作答时给出代答占比", () => {
    expect(proxyCountText({ proxy_answered: 2, self_answered: 6 })).toBe("代答 2/8 题");
  });

  it("全部本人作答", () => {
    expect(proxyCountText({ proxy_answered: 0, self_answered: 5 })).toBe("代答 0/5 题");
  });

  it("尚未作答时不显示 0/0", () => {
    expect(proxyCountText({ proxy_answered: 0, self_answered: 0 })).toBe("尚未作答");
    expect(proxyCountText(undefined)).toBe("尚未作答");
  });

  it("负数脏数据按 0 处理，不出现负分母", () => {
    expect(proxyCountText({ proxy_answered: -1, self_answered: 3 })).toBe("代答 0/3 题");
  });
});

describe("proxyNameError", () => {
  it("代答必须填姓名", () => {
    expect(proxyNameError("proxy", "")).toContain("代答人姓名");
    expect(proxyNameError("proxy", "   ")).toContain("代答人姓名");
  });

  it("本人作答或医护代填不要求姓名", () => {
    expect(proxyNameError("self", "")).toBeNull();
    expect(proxyNameError("staff", "")).toBeNull();
  });

  it("填了姓名就放行", () => {
    expect(proxyNameError("proxy", "李小雨")).toBeNull();
  });
});
