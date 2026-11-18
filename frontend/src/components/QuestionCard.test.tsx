import { useState } from "react";

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { QuestionCard } from "@/components/QuestionCard";
import type { ScaleQuestion } from "@/lib/types";

/**
 * 题目卡片组件测试（A-6）。
 *
 * 重点不在「按钮能点」，而在**实测值到分档的映射**：老人填了 6.5 秒却显示成
 * 「基本独立（2 分）」，界面和结论就一起错了。这里和 conditions.ts 一样，
 * 与后端 `_band_for` 保持同一口径：按选项顺序取第一个命中区间。
 */

const bandedQuestion: ScaleQuestion = {
  code: "B2-01",
  text: "独立完成购物",
  input_type: "single",
  banded_input: true,
  unit: "秒",
  options: [
    { value: "independent", label: "基本独立（<5 秒）", score: 2, min: 0, max: 4.99 },
    { value: "partial", label: "需部分帮助（5~15 秒）", score: 1, min: 5, max: 15 },
    { value: "dependent", label: "完全依赖（>15 秒）", score: 0, min: 15.01, max: 999 },
    { value: "cannot", label: "不能完成", score: 0 },
  ],
  fallback_options: ["cannot"],
};

const singleQuestion: ScaleQuestion = {
  code: "B1-01",
  text: "进食",
  input_type: "single",
  options: [
    { value: "10", label: "10 分：完全自理", score: 10 },
    { value: "5", label: "5 分：需部分帮助", score: 5 },
    { value: "0", label: "0 分：完全依赖", score: 0 },
  ],
};

const multiQuestion: ScaleQuestion = {
  code: "B7-01",
  text: "本次就诊的主要原因",
  input_type: "multi",
  options: [
    { value: "dizzy", label: "头晕", score: 1 },
    { value: "fall", label: "跌倒", score: 2 },
  ],
};

describe("QuestionCard：实测分档", () => {
  it("填入实测值后显示将要落到的档位与分值", () => {
    render(
      <QuestionCard
        question={bandedQuestion}
        index={1}
        total={4}
        value={null}
        measured={6.5}
        onChange={() => {}}
      />,
    );

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("将记为：需部分帮助（5~15 秒）");
    expect(status).toHaveTextContent("本题 1 分");
  });

  it("数值落在所有区间之外时提示重填，不默认按 0 分处理", () => {
    render(
      <QuestionCard
        question={bandedQuestion}
        index={1}
        total={4}
        value={null}
        measured={999.5}
        onChange={() => {}}
      />,
    );

    expect(screen.getByText(/不在标准给定的任何区间内/)).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("输入实测值时把数值交给上层，由服务端落档", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    /** 受控：必须把 measured 写回，否则每敲一个字符输入框就被清空 */
    function Harness() {
      const [measured, setMeasured] = useState<number | undefined>(undefined);
      return (
        <QuestionCard
          question={bandedQuestion}
          index={1}
          total={4}
          value={null}
          measured={measured}
          onChange={(_value, nextMeasured) => {
            onChange(nextMeasured);
            setMeasured(nextMeasured);
          }}
        />
      );
    }

    render(<Harness />);

    await user.type(screen.getByLabelText("独立完成购物（实测数值）"), "12");

    expect(onChange).toHaveBeenLastCalledWith(12);
  });

  it("点兜底选项时清空实测值，两者互斥", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <QuestionCard
        question={bandedQuestion}
        index={1}
        total={4}
        value={null}
        measured={6.5}
        onChange={onChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: /不能完成/ }));

    expect(onChange).toHaveBeenCalledWith("cannot", undefined);
  });
});

describe("QuestionCard：单选与多选", () => {
  it("单选题点选项返回该选项的 value（计分由后端按题库算）", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <QuestionCard
        question={singleQuestion}
        index={2}
        total={10}
        value={null}
        onChange={onChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: /5 分：需部分帮助/ }));

    expect(onChange).toHaveBeenCalledWith("5");
  });

  it("多选题在已选基础上追加，再点一次取消", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(
      <QuestionCard
        question={multiQuestion}
        index={3}
        total={10}
        value={["dizzy"]}
        onChange={onChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: /跌倒/ }));
    expect(onChange).toHaveBeenLastCalledWith(["dizzy", "fall"]);

    rerender(
      <QuestionCard
        question={multiQuestion}
        index={3}
        total={10}
        value={["dizzy", "fall"]}
        onChange={onChange}
      />,
    );
    await user.click(screen.getByRole("button", { name: /头晕/ }));
    expect(onChange).toHaveBeenLastCalledWith(["fall"]);
  });

  it("家属代答时标注出来，避免把代答当成老人自述", () => {
    render(
      <QuestionCard
        question={singleQuestion}
        index={1}
        total={10}
        value={null}
        onChange={() => {}}
        isProxy
      />,
    );

    expect(screen.getByText("家属代答")).toBeInTheDocument();
  });
});
