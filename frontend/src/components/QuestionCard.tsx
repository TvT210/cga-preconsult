"use client";

import { useEffect, useMemo, useState } from "react";
import type { AnswerValue, ScaleOption, ScaleQuestion } from "@/lib/types";

export interface QuestionCardProps {
  question: ScaleQuestion;
  /** 从 1 开始的题号 */
  index: number;
  total: number;
  /** 当前作答 */
  value: AnswerValue;
  /** 当前已记录的实测值（秒数／词语数），用于断点续填与回退后还原 */
  measured?: number;
  onChange: (value: AnswerValue, measured?: number) => void;
  /** 是否为家属代答 */
  isProxy?: boolean;
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** 与后端 `_band_for` 同一口径：按题库选项顺序取第一个命中的区间 */
function matchBand(
  options: ScaleOption[],
  measured: number,
): ScaleOption | undefined {
  return options.find((option) => {
    if (option.min === undefined && option.max === undefined) return false;
    const low = option.min ?? Number.NEGATIVE_INFINITY;
    const high = option.max ?? Number.POSITIVE_INFINITY;
    return measured >= low && measured <= high;
  });
}

/**
 * 单题卡片：一屏一题，按 input_type 分派渲染。
 * - single：大号单选按钮组
 * - multi ：大号多选按钮组
 * - number：大号数字输入，实测项附单位与计时提示
 * - 实测分档题（`banded_input`）：填数值 → 服务端按区间落档；另渲染「不能完成」类兜底选项
 */
export function QuestionCard({
  question,
  index,
  total,
  value,
  measured,
  onChange,
  isProxy = false,
}: QuestionCardProps) {
  const options = useMemo(() => question.options ?? [], [question.options]);
  const [elapsed, setElapsed] = useState(0);
  const [timing, setTiming] = useState(false);

  const banded = Boolean(question.banded_input);
  const fallbackValues = useMemo(
    () => new Set(question.fallback_options ?? []),
    [question.fallback_options],
  );
  const bandedOptions = useMemo(
    () => options.filter((option) => !fallbackValues.has(option.value)),
    [options, fallbackValues],
  );
  const fallbackOptions = useMemo(
    () => options.filter((option) => fallbackValues.has(option.value)),
    [options, fallbackValues],
  );

  /** 秒为单位的实测项才提供计时器（词语数、月份等无法「计时」） */
  const timerEnabled = Boolean(question.unit) && question.unit === "s";
  const isMeasured = Boolean(question.unit) || banded;

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

  const matchedBand = useMemo(() => {
    if (!banded || measured === undefined || measured === null) return undefined;
    return matchBand(bandedOptions, Number(measured));
  }, [banded, bandedOptions, measured]);

  const hasAnswer =
    (measured !== undefined && measured !== null) ||
    selectedValues.length > 0;

  const toggleMulti = (optionValue: string) => {
    const next = selectedValues.includes(optionValue)
      ? selectedValues.filter((v) => v !== optionValue)
      : [...selectedValues, optionValue];
    onChange(next);
  };

  /** 输入实测数值：清空兜底选项，交由服务端落档 */
  const handleMeasuredInput = (raw: string) => {
    if (raw === "") {
      onChange(null, undefined);
      return;
    }
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) return;
    onChange(null, parsed);
  };

  /** 选择兜底选项：清空实测值，与数值互斥 */
  const handleFallbackPick = (optionValue: string) => {
    onChange(optionValue, undefined);
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
        {banded ? (
          <span className="rounded-full bg-medical-100 px-3 py-1 text-elder text-medical-800">
            实测项
          </span>
        ) : null}
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

      {/* ---------------- 实测分档题：填数值 → 服务端落档 ---------------- */}
      {banded ? (
        <div className="space-y-5">
          {question.unit_hint ? (
            <p className="rounded-xl border-2 border-medical-200 bg-medical-50 px-4 py-3 text-elder text-medical-900">
              {question.unit_hint}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-4">
            <input
              type="number"
              inputMode="decimal"
              step="any"
              min={0}
              className="field-input h-[72px] max-w-xs text-center text-elder-2xl"
              value={measured === undefined || measured === null ? "" : String(measured)}
              onChange={(event) => handleMeasuredInput(event.target.value)}
              placeholder="请输入数值"
              aria-label={`${question.text}（实测数值）`}
            />
            {question.unit ? (
              <span className="text-elder-lg font-semibold text-ink">{question.unit}</span>
            ) : null}
          </div>

          {timerEnabled ? (
            <div className="rounded-xl border-2 border-medical-200 bg-medical-50 p-4">
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-elder-lg font-semibold text-medical-900">
                  已用时 {formatElapsed(elapsed)}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    if (timing) {
                      setTiming(false);
                      // 至少 1 秒才写入，避免误点产生 0 秒
                      if (elapsed > 0) onChange(null, elapsed);
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
              <p className="mt-2 text-elder text-ink-soft">
                也可以直接在上方填写测得的数值。
              </p>
            </div>
          ) : null}

          {matchedBand ? (
            <p
              className="rounded-xl border-2 border-medical-300 bg-white px-4 py-3 text-elder text-ink"
              role="status"
            >
              将记为：<span className="font-semibold">{matchedBand.label}</span>
              {typeof matchedBand.score === "number"
                ? `（本题 ${matchedBand.score} 分）`
                : ""}
            </p>
          ) : measured !== undefined && measured !== null ? (
            <p className="rounded-xl border-2 border-amber-300 bg-amber-50 px-4 py-3 text-elder text-amber-900">
              该数值不在标准给定的任何区间内，请核对后重填，或与医护人员确认。
            </p>
          ) : null}

          {fallbackOptions.length ? (
            <div className="space-y-3">
              <p className="text-elder text-ink-soft">无法获得数值时，请选择：</p>
              {fallbackOptions.map((option) => {
                const active = selectedValues[0] === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={active}
                    onClick={() => handleFallbackPick(option.value)}
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
        </div>
      ) : null}

      {!banded && question.input_type === "single" ? (
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

      {!banded && question.input_type === "multi" ? (
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

      {!banded && question.input_type === "number" ? (
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
                {question.unit_hint ?? "本题为实测项目，请按医护人员指导完成，并把用时或数值填入上方。"}
              </p>
              {timerEnabled ? (
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <span className="text-elder-lg font-semibold text-medical-900">
                    已用时 {formatElapsed(elapsed)}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      if (timing) {
                        setTiming(false);
                        if (elapsed > 0) onChange(elapsed, elapsed);
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
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {!hasAnswer && (banded || question.input_type === "number") ? (
        <p className="text-elder text-ink-mute">
          请填入数值，或在下方选择符合表现的一项。
        </p>
      ) : null}
    </section>
  );
}
