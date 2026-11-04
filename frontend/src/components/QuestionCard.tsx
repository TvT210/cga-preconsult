"use client";

import { useEffect, useMemo, useState } from "react";
import type { AnswerValue, ScaleQuestion } from "@/lib/types";

export interface QuestionCardProps {
  question: ScaleQuestion;
  /** 从 1 开始的题号 */
  index: number;
  total: number;
  /** 当前作答 */
  value: AnswerValue;
  onChange: (value: AnswerValue, measured?: number) => void;
  /** 是否为家属代答 */
  isProxy?: boolean;
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * 单题卡片：一屏一题，按 input_type 分派渲染。
 * - single：大号单选按钮组
 * - multi ：大号多选按钮组
 * - number：大号数字输入，实测项附单位与计时提示
 */
export function QuestionCard({
  question,
  index,
  total,
  value,
  onChange,
  isProxy = false,
}: QuestionCardProps) {
  const options = question.options ?? [];
  const [measured, setMeasured] = useState<number | undefined>(undefined);
  const [elapsed, setElapsed] = useState(0);
  const [timing, setTiming] = useState(false);

  const isMeasured = Boolean(question.unit);

  useEffect(() => {
    if (!timing) return;
    const timer = window.setInterval(() => {
      setElapsed((prev) => prev + 1);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [timing]);

  const selectedValues = useMemo<string[]>(() => {
    if (Array.isArray(value)) return value.map((v) => String(v));
    if (value === null || value === undefined || value === "") return [];
    return [String(value)];
  }, [value]);

  const toggleMulti = (optionValue: string) => {
    const next = selectedValues.includes(optionValue)
      ? selectedValues.filter((v) => v !== optionValue)
      : [...selectedValues, optionValue];
    onChange(next);
  };

  return (
    <section
      className="card card-pad animate-fade-in-up space-y-6"
      aria-labelledby={`question-title-${question.code}`}
    >
      <header className="flex flex-wrap items-center gap-3">
        <span className="rounded-full bg-medical-100 px-4 py-1 text-elder font-semibold text-medical-800">
          第 {index} 题 / 共 {total} 题
        </span>
        {question.required ? (
          <span className="rounded-full bg-red-50 px-3 py-1 text-elder text-red-700">
            必答
          </span>
        ) : (
          <span className="rounded-full bg-slate-100 px-3 py-1 text-elder text-ink-soft">
            可跳过
          </span>
        )}
        {isProxy ? (
          <span className="rounded-full bg-amber-100 px-3 py-1 text-elder text-amber-900">
            家属代答
          </span>
        ) : null}
      </header>

      <div>
        <h2
          id={`question-title-${question.code}`}
          className="text-elder-2xl font-semibold leading-snug text-ink"
        >
          {question.text}
        </h2>
        {question.plain_text ? (
          <p className="mt-3 text-elder text-ink-soft">{question.plain_text}</p>
        ) : null}
      </div>

      {question.input_type === "single" ? (
        <div className="space-y-3" role="group" aria-label="请选择一项">
          {options.map((option) => {
            const active = selectedValues[0] === option.value;
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={active}
                onClick={() => onChange(option.value)}
                className={[
                  "flex w-full items-center gap-4 rounded-xl border-2 px-5 py-5 text-left text-elder-lg transition-colors",
                  "min-h-btn-lg",
                  active
                    ? "border-medical-700 bg-medical-50 text-medical-900"
                    : "border-slate-300 bg-white text-ink hover:border-medical-400",
                ].join(" ")}
              >
                <span
                  aria-hidden="true"
                  className={[
                    "flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2",
                    active ? "border-medical-700 bg-medical-700" : "border-slate-400",
                  ].join(" ")}
                >
                  {active ? <span className="h-3 w-3 rounded-full bg-white" /> : null}
                </span>
                <span>{option.label}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      {question.input_type === "multi" ? (
        <div className="space-y-3" role="group" aria-label="可选择多项">
          {options.map((option) => {
            const active = selectedValues.includes(option.value);
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={active}
                onClick={() => toggleMulti(option.value)}
                className={[
                  "flex w-full items-center gap-4 rounded-xl border-2 px-5 py-5 text-left text-elder-lg transition-colors",
                  "min-h-btn-lg",
                  active
                    ? "border-medical-700 bg-medical-50 text-medical-900"
                    : "border-slate-300 bg-white text-ink hover:border-medical-400",
                ].join(" ")}
              >
                <span
                  aria-hidden="true"
                  className={[
                    "flex h-8 w-8 shrink-0 items-center justify-center rounded border-2",
                    active
                      ? "border-medical-700 bg-medical-700 text-white"
                      : "border-slate-400",
                  ].join(" ")}
                >
                  {active ? (
                    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={3}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="m5 13 4 4L19 7" />
                    </svg>
                  ) : null}
                </span>
                <span>{option.label}</span>
              </button>
            );
          })}
          <p className="text-elder text-ink-mute">可以选多项，选好后点「下一题」。</p>
        </div>
      ) : null}

      {question.input_type === "number" ? (
        <div className="space-y-4">
          <div className="flex items-center gap-4">
            <input
              type="number"
              inputMode="numeric"
              step="any"
              className="field-input h-[72px] max-w-xs text-center text-elder-2xl"
              value={value === null || value === undefined ? "" : String(value)}
              onChange={(event) => {
                const raw = event.target.value;
                onChange(raw === "" ? null : Number(raw), measured);
              }}
              placeholder="请输入数字"
              aria-label={question.text}
            />
            {question.unit ? (
              <span className="text-elder-lg font-semibold text-ink">{question.unit}</span>
            ) : null}
          </div>
          {question.min !== undefined || question.max !== undefined ? (
            <p className="text-elder text-ink-soft">
              取值范围：{question.min ?? "不限"} ~ {question.max ?? "不限"}
            </p>
          ) : null}

          {isMeasured ? (
            <div className="rounded-xl border-2 border-medical-200 bg-medical-50 p-4">
              <p className="text-elder text-medical-900">
                本题为实测项目，请按医护人员指导完成，并把用时或数值填入上方。
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <span className="text-elder-lg font-semibold text-medical-900">
                  已用时 {formatElapsed(elapsed)}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    if (timing) {
                      setTiming(false);
                      setMeasured(elapsed);
                    } else {
                      setElapsed(0);
                      setTiming(true);
                    }
                  }}
                  className="min-h-btn rounded-xl border-2 border-medical-700 bg-white px-5 py-3 text-elder font-semibold text-medical-700"
                >
                  {timing ? "停止计时并记录" : "开始计时"}
                </button>
              </div>
              {measured !== undefined ? (
                <p className="mt-2 text-elder text-medical-900">已记录用时 {measured} 秒。</p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
