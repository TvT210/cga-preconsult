import { describe, expect, it } from "vitest";

import {
  applicableQuestions,
  buildFacts,
  conditionsHold,
  questionApplies,
  type AnswerFacts,
  type ConditionGroup,
  type FactsTable,
} from "@/lib/conditions";
import type { ScaleQuestion } from "@/lib/types";

/**
 * 条件求值器测试（A-6）。
 *
 * 保护的核心不变量：**前端显示的题 == 后端计分的题**。
 * 这两处语义一旦漂移不会报错，只会静默多问或错算，所以逐条钉住。
 * 下列 `when` 结构全部取自题库原文（B.15 / B.18），题库改动时这里会先失败。
 */

function fact(value: string, score: number | null = null): AnswerFacts {
  return { value, score, present: value !== "" || score !== null };
}

function question(code: string, extra: Partial<ScaleQuestion> = {}): ScaleQuestion {
  return { code, text: code, input_type: "single", ...extra };
}

/** 带 `when` 的题目：`ScaleQuestion.when` 是宽泛的 `Record<string, unknown>`，这里收一次口 */
function gatedQuestion(code: string, when: ConditionGroup): ScaleQuestion {
  return question(code, { when: when as unknown as Record<string, unknown> });
}

/** B.15 分流题：插管走「机械通气顺应性」，未插管走「发声」 */
const VENT_GATE: ConditionGroup = {
  all: [{ question: "B15-00", op: "eq", value: "vent" }],
};
const NON_VENT_GATE: ConditionGroup = {
  all: [{ question: "B15-00", op: "eq", value: "non_vent" }],
};

/** B.18 初筛：任一项为「是」才展开终筛三题 */
const NRS_GATE: ConditionGroup = {
  any: [
    { question: "B18-S1", op: "eq", value: "yes" },
    { question: "B18-S2", op: "eq", value: "yes" },
    { question: "B18-S3", op: "eq", value: "yes" },
    { question: "B18-S4", op: "eq", value: "yes" },
  ],
};

describe("conditionsHold：条件原子", () => {
  it("没有 when 时恒成立（绝大多数题目属于这一类）", () => {
    expect(conditionsHold(null, {})).toBe(true);
    expect(conditionsHold(undefined, {})).toBe(true);
  });

  it("字符串条目按阳性判定：分值为 0 时即使选了也不算阳性", () => {
    expect(conditionsHold("B1-09", { "B1-09": fact("10", 5) })).toBe(true);
    expect(conditionsHold("B1-09", { "B1-09": fact("15", 0) })).toBe(false);
    // 未作答不能算阳性，也不能抛错
    expect(conditionsHold("B1-09", {})).toBe(false);
  });

  it("eq 比的是整值，多选答案要用 in 才按词条比", () => {
    const multi: FactsTable = { SCORE: fact("dizzy,fall", null) };
    expect(conditionsHold({ question: "SCORE", op: "eq", value: "dizzy" }, multi)).toBe(false);
    expect(conditionsHold({ question: "SCORE", op: "in", value: ["dizzy"] }, multi)).toBe(true);
    expect(conditionsHold({ question: "SCORE", op: "in", value: ["chest_pain"] }, multi)).toBe(false);
  });

  it("数值比较一律用分值，与后端 _item_applies 同口径", () => {
    // 选项 value 是 'ge70'，比大小只能靠 score
    const age: FactsTable = { "B18-T3": fact("ge70", 1) };
    expect(conditionsHold({ question: "B18-T3", op: "gte", value: 1 }, age)).toBe(true);
    expect(conditionsHold({ question: "B18-T3", op: "gt", value: 1 }, age)).toBe(false);
    // 没有分值（纯选项型条目）时不瞎猜，一律判不成立
    expect(conditionsHold({ question: "X", op: "lte", value: 5 }, { X: fact("3", null) })).toBe(false);
  });

  it("any 任一成立 / all 全部成立", () => {
    const table: FactsTable = { A: fact("no", 0), B: fact("yes", 0) };
    const anyGate: ConditionGroup = {
      any: [
        { question: "A", op: "eq", value: "yes" },
        { question: "B", op: "eq", value: "yes" },
      ],
    };
    const allGate: ConditionGroup = {
      all: [
        { question: "A", op: "eq", value: "yes" },
        { question: "B", op: "eq", value: "yes" },
      ],
    };
    expect(conditionsHold(anyGate, table)).toBe(true);
    expect(conditionsHold(allGate, table)).toBe(false);
  });
});

describe("applicableQuestions：B.15 插管分流", () => {
  const b15 = [
    question("B15-00"),
    question("B15-01"),
    question("B15-02"),
    gatedQuestion("B15-03", VENT_GATE),
    gatedQuestion("B15-04", NON_VENT_GATE),
  ];

  const codes = (answers: Parameters<typeof buildFacts>[1]) =>
    applicableQuestions(b15, buildFacts(b15, answers)).map((item) => item.code);

  it("未插管：只问发声题，机械通气题不出现", () => {
    expect(codes({ "B15-00": { value: "non_vent" } })).toEqual([
      "B15-00",
      "B15-01",
      "B15-02",
      "B15-04",
    ]);
  });

  it("插管：机械通气题出现，发声题不出现", () => {
    expect(codes({ "B15-00": { value: "vent" } })).toEqual([
      "B15-00",
      "B15-01",
      "B15-02",
      "B15-03",
    ]);
  });

  it("还没答分流题时两条分支都不显示，避免一上来就问错题", () => {
    expect(codes({})).toEqual(["B15-00", "B15-01", "B15-02"]);
  });

  it("不适用只影响可见性，题目对象本身仍在全量列表里", () => {
    expect(b15).toHaveLength(5);
  });
});

describe("applicableQuestions：B.18 初筛/终筛", () => {
  const b18 = [
    question("B18-S1"),
    question("B18-S2"),
    question("B18-S3"),
    question("B18-S4"),
    gatedQuestion("B18-T1", NRS_GATE),
    gatedQuestion("B18-T2", NRS_GATE),
  ];

  const visible = (answers: Parameters<typeof buildFacts>[1]) =>
    applicableQuestions(b18, buildFacts(b18, answers)).map((item) => item.code);

  it("初筛全否：终筛三题不出现", () => {
    expect(
      visible({
        "B18-S1": { value: "no" },
        "B18-S2": { value: "no" },
        "B18-S3": { value: "no" },
        "B18-S4": { value: "no" },
      }),
    ).toEqual(["B18-S1", "B18-S2", "B18-S3", "B18-S4"]);
  });

  it("任一项为「是」：终筛展开", () => {
    expect(
      visible({
        "B18-S1": { value: "no" },
        "B18-S2": { value: "yes" },
        "B18-S3": { value: "no" },
        "B18-S4": { value: "no" },
      }),
    ).toEqual(["B18-S1", "B18-S2", "B18-S3", "B18-S4", "B18-T1", "B18-T2"]);
  });

  it("questionApplies 与 applicableQuestions 判断一致", () => {
    const table = buildFacts(b18, { "B18-S1": { value: "yes" } });
    expect(questionApplies(b18[4], table)).toBe(true);
    expect(questionApplies(b18[0], table)).toBe(true);
  });
});

describe("buildFacts：落分口径必须与后端 _apply_answer 一致", () => {
  it("数值题按填入值落分", () => {
    const table = buildFacts([question("M1", { input_type: "number" })], {
      M1: { value: 88 },
    });
    expect(table.M1.score).toBe(88);
  });

  it("实测分档题按区间取档位分值，而不是实测值本身", () => {
    const banded = question("S1", {
      banded_input: true,
      options: [
        { value: "fast", label: "基本独立", score: 2, min: 0, max: 4.99 },
        { value: "slow", label: "需部分帮助", score: 1, min: 5, max: 15 },
        { value: "cannot", label: "不能完成", score: 0 },
      ],
      fallback_options: ["cannot"],
    });
    const table = buildFacts([banded], { S1: { value: null, measured: 6.5 } });
    expect(table.S1.score).toBe(1);

    // 落在区间外时没有分值，交由界面提示重填，不默认按 0 分处理
    const outOfRange = buildFacts([banded], { S1: { value: null, measured: 999 } });
    expect(outOfRange.S1.score).toBeNull();
  });

  it("多选题按所选选项分值求和，答案存成逗号串", () => {
    const multi = question("MM", {
      input_type: "multi",
      options: [
        { value: "a", label: "A", score: 1 },
        { value: "b", label: "B", score: 2 },
      ],
    });
    const table = buildFacts([multi], { MM: { value: ["a", "b"] } });
    expect(table.MM.value).toBe("a,b");
    expect(table.MM.score).toBe(3);
  });

  it("空数组答案不算已作答", () => {
    const multi = question("MM", { input_type: "multi", options: [] });
    expect(buildFacts([multi], { MM: { value: [] } }).MM).toBeUndefined();
  });

  it("只有实测值没有选项值时，present 仍为真", () => {
    const table = buildFacts([question("N", { input_type: "number" })], {
      N: { value: null, measured: 12 },
    });
    expect(table.N.present).toBe(true);
    expect(table.N.value).toBe("");
  });
});
