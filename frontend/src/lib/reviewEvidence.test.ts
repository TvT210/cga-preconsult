import { describe, expect, it } from "vitest";

import {
  EVIDENCE_OPTIONS,
  evidenceLabel,
  evidenceNeedsSignedDocument,
  evidenceSummary,
  evidenceWarning,
} from "./reviewEvidence";

describe("evidenceLabel", () => {
  it("三种凭据都有中文名", () => {
    expect(evidenceLabel("signed_document")).toBe("签字件");
    expect(evidenceLabel("in_system")).toBe("系统内审批");
    expect(evidenceLabel("verbal_confirmation")).toBe("口头确认");
  });

  it("空值不拼成空字符串，而是明确说「未记录」", () => {
    expect(evidenceLabel("")).toBe("凭据未记录");
    expect(evidenceLabel(undefined)).toBe("凭据未记录");
  });

  it("未知值原样返回，便于发现后端新增了没同步的凭据类型", () => {
    expect(evidenceLabel("notarized")).toBe("notarized");
  });
});

describe("evidenceNeedsSignedDocument", () => {
  it("只有签字件才算凭据齐全", () => {
    expect(evidenceNeedsSignedDocument("signed_document")).toBe(false);
    expect(evidenceNeedsSignedDocument("in_system")).toBe(true);
    expect(evidenceNeedsSignedDocument("verbal_confirmation")).toBe(true);
  });

  it("未选择凭据时不算「缺签字件」，避免进页面就弹警告", () => {
    expect(evidenceNeedsSignedDocument("")).toBe(false);
    expect(evidenceNeedsSignedDocument(undefined)).toBe(false);
  });
});

describe("evidenceWarning", () => {
  it("凭据不足时说明后果：状态生效但判读保留提示", () => {
    const text = evidenceWarning("verbal_confirmation");
    expect(text).toContain("签字件待补");
    expect(text).toContain("正式出具前需医护确认");
  });

  it("有签字件时不吓人", () => {
    expect(evidenceWarning("signed_document")).toBe("");
  });
});

describe("evidenceSummary", () => {
  it("把签字人、职称、凭据、日期拼成一句", () => {
    expect(
      evidenceSummary("王建民", "主任医师", "verbal_confirmation", "2026-11-18T00:00:00"),
    ).toBe("王建民（主任医师） · 口头确认 · 2026-11-18");
  });

  it("缺职称时不留空括号", () => {
    expect(evidenceSummary("王建民", "", "in_system", "")).toBe("王建民 · 系统内审批");
  });

  it("什么都没填时给破折号，而不是半截话", () => {
    expect(evidenceSummary("", "", "", "")).toBe("—");
    expect(evidenceSummary(undefined, undefined, undefined, undefined)).toBe("—");
  });

  it("只有凭据没有签字人时仍能说明情况", () => {
    expect(evidenceSummary("", "", "verbal_confirmation", "")).toBe("口头确认");
  });
});

describe("EVIDENCE_OPTIONS", () => {
  it("每个选项都写了后果说明，不能只有一个标签", () => {
    expect(EVIDENCE_OPTIONS).toHaveLength(3);
    EVIDENCE_OPTIONS.forEach((option) => {
      expect(option.hint.length).toBeGreaterThan(10);
    });
  });

  it("口头确认的说明里点明要「写明依据」", () => {
    const verbal = EVIDENCE_OPTIONS.find((option) => option.value === "verbal_confirmation");
    expect(verbal?.hint).toContain("写明依据");
  });
});
