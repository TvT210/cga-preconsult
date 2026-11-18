import { describe, expect, it } from "vitest";

import {
  conflictKindLabel,
  conflictValueText,
  elderConflictLine,
  groupConflicts,
} from "@/lib/conflicts";
import type { DialogueConflict } from "@/lib/types";

/**
 * 冲突标记归一口测试（A-8）。
 *
 * 保护两个不变量：
 * 1. 老人端**不出现英文键**——`symptoms：…` 这种字对老人等于没说；
 * 2. 医护端**不重复**——同一处矛盾每轮对话都会重新检出，
 *    不去重会让复核页堆出十几条一样的待办，医护很快就不看了。
 */

function flag(partial: Partial<DialogueConflict>): DialogueConflict {
  return { field: "symptoms", ...partial };
}

describe("conflictKindLabel", () => {
  it("四类都有中文名", () => {
    expect(conflictKindLabel("symptoms")).toBe("症状与量表结果");
    expect(conflictKindLabel("complaint")).toBe("主诉与后续描述");
    expect(conflictKindLabel("medication")).toBe("用药记录");
    expect(conflictKindLabel("history")).toBe("既往史");
  });

  it("未知类别退回通用说法，不透出英文键", () => {
    expect(conflictKindLabel("something_new")).toBe("信息不一致");
    expect(conflictKindLabel(undefined)).toBe("信息不一致");
  });
});

describe("conflictValueText", () => {
  it("数组用顿号连，缺省不打出 undefined", () => {
    expect(conflictValueText(["difficulty_walking", "dizziness"])).toBe(
      "difficulty_walking、dizziness",
    );
    expect(conflictValueText(undefined)).toBe("");
    expect(conflictValueText(null)).toBe("");
    expect(conflictValueText("头晕")).toBe("头晕");
  });
});

describe("elderConflictLine", () => {
  it("同时有对话侧与记录侧时两边都说清", () => {
    const line = elderConflictLine(
      flag({
        kind: "symptoms",
        dialogue_value: ["difficulty_walking"],
        scale_value: "B.1 未提示异常",
      }),
    );
    expect(line).toContain("症状与量表结果");
    expect(line).toContain("difficulty_walking");
    expect(line).toContain("B.1 未提示异常");
    expect(line).toContain("请医生核对");
  });

  it("画像类冲突读 profile_value，不读空的 scale_value", () => {
    const line = elderConflictLine(
      flag({
        kind: "history",
        dialogue_value: "否认「高血压」",
        profile_value: "既往史：高血压",
        scale_value: "",
      }),
    );
    expect(line).toContain("既往史：高血压");
  });

  it("不出现英文类别键", () => {
    const line = elderConflictLine(flag({ kind: "medication", dialogue_value: "称已停用「氨氯地平」" }));
    expect(line).not.toMatch(/medication|symptoms|history|complaint/);
  });

  it("没带类别时也不抛错", () => {
    expect(elderConflictLine({ field: "", note: "x" })).toContain("请医生核对");
  });
});

describe("groupConflicts", () => {
  it("按类别分组，warn 组排前面", () => {
    const groups = groupConflicts([
      flag({ kind: "complaint", severity: "info", dialogue_value: "否认「头晕」" }),
      flag({ kind: "history", severity: "warn", dialogue_value: "否认「高血压」" }),
    ]);
    expect(groups.map((group) => group.kind)).toEqual(["history", "complaint"]);
    expect(groups[0].warn).toBe(true);
    expect(groups[1].warn).toBe(false);
  });

  it("同一处矛盾多轮重复检出只留一条", () => {
    const repeated = [
      flag({ kind: "history", dialogue_value: "否认「高血压」", profile_value: "既往史：高血压" }),
      flag({ kind: "history", dialogue_value: "否认「高血压」", profile_value: "既往史：高血压" }),
      flag({ kind: "history", dialogue_value: "否认「高血压」", profile_value: "既往史：高血压" }),
    ];
    const groups = groupConflicts(repeated);
    expect(groups).toHaveLength(1);
    expect(groups[0].items).toHaveLength(1);
  });

  it("同一类别下不同内容不会被合并掉", () => {
    const groups = groupConflicts([
      flag({ kind: "history", dialogue_value: "否认「高血压」" }),
      flag({ kind: "history", dialogue_value: "否认「2 型糖尿病」" }),
    ]);
    expect(groups[0].items).toHaveLength(2);
  });

  it("空输入返回空数组，不抛错", () => {
    expect(groupConflicts([])).toEqual([]);
    expect(groupConflicts(undefined)).toEqual([]);
  });

  it("旧结构只有 field 时也能归类", () => {
    const groups = groupConflicts([{ field: "symptoms", dialogue_value: ["a"] }]);
    expect(groups[0].kind).toBe("symptoms");
    expect(groups[0].label).toBe("症状与量表结果");
  });
});
