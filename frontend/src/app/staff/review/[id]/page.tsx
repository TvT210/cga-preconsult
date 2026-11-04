"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { api } from "@/lib/api";
import { assessmentStatusLabel, formatDateTime } from "@/lib/format";
import type {
  AnswerValue,
  AssessmentAnswer,
  AssessmentSession,
  Correction,
  ScaleDetail,
  ScaleQuestion,
} from "@/lib/types";
import { BigButton } from "@/components/BigButton";
import { EmptyState, ErrorState, LoadingState } from "@/components/ErrorState";
import { PageHeader } from "@/components/PageHeader";
import { StatusBadge } from "@/components/StatusBadge";
import { useToast } from "@/components/Toast";

/** 复核接口返回的判读结果 */
interface ReviewScore {
  total?: number;
  level?: string;
  interpretation?: string;
  abnormal?: boolean;
  needs_manual_review?: boolean;
}

/** 将作答值转为可展示文本 */
function displayValue(question: ScaleQuestion, value: AnswerValue): string {
  if (value === null || value === undefined || value === "") return "未作答";
  if (question.input_type === "number") {
    return `${value}${question.unit ?? ""}`;
  }
  const options = question.options ?? [];
  const selected = Array.isArray(value) ? value.map(String) : [String(value)];
  const labels = selected.map(
    (v) => options.find((option) => option.value === v)?.label ?? v,
  );
  return labels.join("、");
}

function sameValue(a: AnswerValue, b: AnswerValue): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    const left = a.map(String).sort();
    const right = b.map(String).sort();
    return left.every((item, index) => item === right[index]);
  }
  return String(a ?? "") === String(b ?? "");
}

/** 取某个选项对应的分值 */
function optionScore(question: ScaleQuestion, value: AnswerValue): number | null {
  if (question.input_type === "number") return null;
  const options = question.options ?? [];
  const selected = Array.isArray(value) ? value.map(String) : [String(value)];
  const scores = selected
    .map((v) => options.find((option) => option.value === v)?.score)
    .filter((score): score is number => typeof score === "number");
  if (!scores.length) return null;
  return scores.reduce((acc, item) => acc + item, 0);
}

export default function StaffReviewPage() {
  const params = useParams<{ id: string | string[] }>();
  const assessmentId = Array.isArray(params.id) ? params.id[0] : params.id;
  const toast = useToast();

  const [session, setSession] = useState<AssessmentSession | null>(null);
  const [scale, setScale] = useState<ScaleDetail | null>(null);
  const [questions, setQuestions] = useState<ScaleQuestion[]>([]);
  const [original, setOriginal] = useState<Record<string, AnswerValue>>({});
  const [originalScores, setOriginalScores] = useState<Record<string, number>>({});
  const [edited, setEdited] = useState<Record<string, AnswerValue>>({});
  const [comment, setComment] = useState("");
  const [activeCode, setActiveCode] = useState<string | null>(null);
  /** 复核前的判读结果，用于改分前后对比 */
  const [scoreBefore, setScoreBefore] = useState<ReviewScore | null>(null);
  const [scoreAfter, setScoreAfter] = useState<ReviewScore | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    if (!assessmentId) return;
    setLoading(true);
    setError("");
    try {
      const detail = await api.get<AssessmentSession>(
        `/assessments/${assessmentId}`,
      );
      setSession(detail);

      let questionList = detail.questions ?? [];
      if (detail.scale_code) {
        try {
          const scaleDetail = await api.get<ScaleDetail>(
            `/scales/${encodeURIComponent(detail.scale_code)}`,
          );
          setScale(scaleDetail);
          const flat = (scaleDetail.sections ?? []).flatMap(
            (section) => section.questions ?? [],
          );
          if (flat.length) questionList = flat;
        } catch {
          /* 量表详情不可用时退回会话内的题目 */
        }
      }
      setQuestions(questionList);

      const answers: Record<string, AnswerValue> = {};
      const scores: Record<string, number> = {};
      (detail.answers ?? []).forEach((answer: AssessmentAnswer) => {
        if (!answer?.question_code) return;
        answers[answer.question_code] = answer.value ?? null;
        if (typeof answer.score === "number") {
          scores[answer.question_code] = answer.score;
        }
      });
      setOriginal(answers);
      setOriginalScores(scores);
      setEdited(answers);
      setActiveCode((prev) => prev ?? questionList[0]?.code ?? null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "暂时无法获取该评估的作答明细。",
      );
    } finally {
      setLoading(false);
    }
  }, [assessmentId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 汇总被修改的题目 */
  const corrections = useMemo<Correction[]>(() => {
    const result: Correction[] = [];
    Object.keys(edited).forEach((code) => {
      if (!sameValue(original[code] ?? null, edited[code] ?? null)) {
        result.push({ question_code: code, value: edited[code] ?? null });
      }
    });
    return result;
  }, [edited, original]);

  const submitReview = useCallback(
    async (action: "approve" | "correct") => {
      if (!session) return;
      if (action === "correct" && corrections.length === 0) {
        toast("尚未修改任何题目取值，无需提交修正。", "warning");
        return;
      }
      setSubmitting(true);
      try {
        const response = await api.post<{ score?: ReviewScore }>(
          `/assessments/${session.id}/review`,
          {
            action,
            corrections,
            comment: comment.trim(),
          },
        );
        if (response?.score) setScoreAfter(response.score);
        toast(action === "approve" ? "复核已通过。" : "修正已提交。", "success");
        await load();
      } catch {
        /* 错误提示已由 api 层统一处理 */
      } finally {
        setSubmitting(false);
      }
    },
    [session, corrections, comment, load, toast],
  );

  if (loading) {
    return <LoadingState label="正在加载作答明细…" />;
  }

  if (error) {
    return <ErrorState message={error} onRetry={() => void load()} />;
  }

  if (!session) {
    return <EmptyState message="未找到该评估记录。" />;
  }

  const statusTone =
    session.status === "reviewed"
      ? "green"
      : session.status === "in_progress"
        ? "blue"
        : "gray";

  const currentScore = (session as unknown as { score?: ReviewScore }).score ?? null;
  const before = scoreBefore ?? currentScore;
  const after = scoreAfter ?? currentScore;
  const scoreChanged =
    before && after && Number(before.total ?? 0) !== Number(after.total ?? 0);

  const activeQuestion =
    questions.find((question) => question.code === activeCode) ?? questions[0] ?? null;

  return (
    <div className="space-y-6">
      <PageHeader
        title={`复核评估：${session.scale_name || session.scale_code}`}
        description={`患者编号 ${session.patient_id} · 采集方式 ${
          session.mode === "staff" ? "医护代填" : "老人自填"
        } · 创建时间 ${formatDateTime(session.created_at)}`}
        actions={
          <>
            <Link href={`/staff/patients/${session.patient_id}`}>
              <BigButton variant="ghost" size="lg">
                查看患者档案
              </BigButton>
            </Link>
            <Link href={`/staff/patients/${session.patient_id}?patient=${session.patient_id}&tab=matching`}>
              <BigButton variant="secondary" size="lg">
                匹配与提醒
              </BigButton>
            </Link>
          </>
        }
      />

      <section className="card card-pad flex flex-wrap items-center gap-4">
        <StatusBadge label={assessmentStatusLabel(session.status)} tone={statusTone} />
        {session.proxy?.is_proxy ? (
          <StatusBadge
            label={`家属代答：${session.proxy.proxy_name ?? ""}${
              session.proxy.proxy_relation ? `（${session.proxy.proxy_relation}）` : ""
            }`}
            tone="amber"
          />
        ) : null}
        {scale?.standard_ref ? (
          <span className="text-elder text-ink-soft">标准依据：{scale.standard_ref}</span>
        ) : null}
      </section>

      {/* ------------------------- 改分前后对比 ------------------------- */}
      <section className="card card-pad">
        <h2 className="section-title">改分前后对比</h2>
        <p className="mt-1 text-elder text-ink-soft">
          复核过程中发生改分的样本会计入质控看板的「计分一致率」，复核前后分值不一致即为计分不一致样本。
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <div className="rounded-xl border-2 border-slate-300 bg-slate-50 p-4">
            <p className="text-elder text-ink-soft">复核前总分</p>
            <p className="mt-1 text-elder-2xl font-bold text-ink">
              {before?.total !== undefined ? before.total : "—"}
            </p>
            <p className="mt-1 text-elder text-ink-soft">{before?.level ?? "—"}</p>
          </div>
          <div className="rounded-xl border-2 border-medical-200 bg-medical-50 p-4">
            <p className="text-elder text-medical-900">复核后总分</p>
            <p className="mt-1 text-elder-2xl font-bold text-medical-900">
              {after?.total !== undefined ? after.total : "—"}
            </p>
            <p className="mt-1 text-elder text-medical-900">{after?.level ?? "—"}</p>
          </div>
          <div className="rounded-xl border-2 border-slate-300 bg-white p-4">
            <p className="text-elder text-ink-soft">本次改动</p>
            <p className="mt-1 text-elder-2xl font-bold text-ink">
              {corrections.length} 题
            </p>
            <p className="mt-1 text-elder text-ink-soft">
              {scoreChanged
                ? "分值已变化，将计为计分不一致样本"
                : corrections.length > 0
                  ? "分值未变化（仅等级或缺项调整）"
                  : "尚未修改任何题目"}
            </p>
          </div>
        </div>
        {after?.interpretation ? (
          <p className="mt-3 rounded-xl bg-slate-50 px-4 py-3 text-elder text-ink-soft">
            判读说明：{after.interpretation}
          </p>
        ) : null}
      </section>

      {/* ------------------------- 左题右答对照 ------------------------- */}
      <section className="grid gap-4 lg:grid-cols-[320px_1fr]">
        {/* 左：题目列表 */}
        <div className="card overflow-hidden">
          <div className="border-b border-slate-200 bg-slate-50 px-4 py-3">
            <p className="text-elder font-semibold text-ink">题目列表</p>
            <p className="mt-1 text-sm text-ink-soft">
              共 {questions.length} 题，已修改 {corrections.length} 题
            </p>
          </div>
          {questions.length === 0 ? (
            <div className="px-4 py-6 text-center text-elder text-ink-mute">
              暂无可复核题目
            </div>
          ) : (
            <ol className="max-h-[560px] overflow-y-auto">
              {questions.map((question, position) => {
                const changed = !sameValue(
                  original[question.code] ?? null,
                  edited[question.code] ?? null,
                );
                const active = activeQuestion?.code === question.code;
                return (
                  <li key={question.code}>
                    <button
                      type="button"
                      onClick={() => setActiveCode(question.code)}
                      aria-current={active ? "true" : undefined}
                      className={[
                        "flex w-full items-start gap-2 border-b border-slate-100 px-4 py-3 text-left",
                        active ? "bg-medical-50" : "hover:bg-slate-50",
                      ].join(" ")}
                    >
                      <span className="text-sm text-ink-mute">
                        {position + 1}.
                      </span>
                      <span className="flex-1 text-elder text-ink">
                        {question.text}
                        {changed ? (
                          <span className="ml-2">
                            <StatusBadge label="已改" tone="amber" />
                          </span>
                        ) : null}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
        </div>

        {/* 右：题目与作答对照 */}
        <div className="card card-pad">
          {!activeQuestion ? (
            <EmptyState message="该评估暂无可复核的题目。" />
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-elder-lg font-semibold text-ink">
                  第 {questions.findIndex((item) => item.code === activeQuestion.code) + 1} 题 ·{" "}
                  {activeQuestion.text}
                </h2>
                {activeQuestion.plain_text ? (
                  <span className="text-elder text-ink-soft">
                    （{activeQuestion.plain_text}）
                  </span>
                ) : null}
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl border-2 border-slate-200 bg-slate-50 p-4">
                  <p className="text-elder text-ink-soft">原作答</p>
                  <p className="mt-1 text-elder font-semibold text-ink">
                    {displayValue(activeQuestion, original[activeQuestion.code] ?? null)}
                  </p>
                  <p className="mt-1 text-elder text-ink-soft">
                    分值：
                    {originalScores[activeQuestion.code] !== undefined
                      ? originalScores[activeQuestion.code]
                      : (optionScore(
                          activeQuestion,
                          original[activeQuestion.code] ?? null,
                        ) ?? "—")}
                  </p>
                </div>
                <div className="rounded-xl border-2 border-medical-200 bg-medical-50 p-4">
                  <p className="text-elder text-medical-900">现作答（可就地修正）</p>
                  <p className="mt-1 text-elder font-semibold text-medical-900">
                    {displayValue(activeQuestion, edited[activeQuestion.code] ?? null)}
                  </p>
                  <p className="mt-1 text-elder text-medical-900">
                    分值：
                    {optionScore(activeQuestion, edited[activeQuestion.code] ?? null) ?? "—"}
                  </p>
                </div>
              </div>

              <div className="mt-4">
                <p className="field-label">选项与分值</p>
                {activeQuestion.input_type === "number" ? (
                  <div className="mt-2 flex items-center gap-3">
                    <input
                      type="number"
                      step="any"
                      className="field-input max-w-xs"
                      value={
                        edited[activeQuestion.code] === null ||
                        edited[activeQuestion.code] === undefined
                          ? ""
                          : String(edited[activeQuestion.code])
                      }
                      aria-label="修正本题取值"
                      onChange={(event) =>
                        setEdited((prev) => ({
                          ...prev,
                          [activeQuestion.code]:
                            event.target.value === "" ? null : Number(event.target.value),
                        }))
                      }
                    />
                    {activeQuestion.unit ? (
                      <span className="text-elder text-ink-soft">{activeQuestion.unit}</span>
                    ) : null}
                  </div>
                ) : (
                  <div className="mt-2 space-y-2">
                    {(activeQuestion.options ?? []).map((option) => {
                      const current = edited[activeQuestion.code] ?? null;
                      const selected = Array.isArray(current)
                        ? current.map(String).includes(option.value)
                        : String(current ?? "") === option.value;
                      const inputType =
                        activeQuestion.input_type === "multi" ? "checkbox" : "radio";
                      return (
                        <label
                          key={option.value}
                          className={[
                            "flex min-h-btn items-center gap-3 rounded-xl border-2 px-4 py-2 text-elder",
                            selected
                              ? "border-medical-700 bg-medical-50 text-medical-900"
                              : "border-slate-200 bg-white text-ink",
                          ].join(" ")}
                        >
                          <input
                            type={inputType}
                            className="h-6 w-6"
                            checked={selected}
                            name={`question-${activeQuestion.code}`}
                            onChange={(event) => {
                              setEdited((prev) => {
                                if (activeQuestion.input_type === "multi") {
                                  const raw = prev[activeQuestion.code];
                                  const list = Array.isArray(raw)
                                    ? raw.map(String)
                                    : [];
                                  const next = event.target.checked
                                    ? [...list, option.value]
                                    : list.filter((item) => item !== option.value);
                                  return { ...prev, [activeQuestion.code]: next };
                                }
                                return { ...prev, [activeQuestion.code]: option.value };
                              });
                            }}
                          />
                          <span className="flex-1">{option.label}</span>
                          <span className="text-elder text-ink-soft">
                            {option.score !== undefined ? `${option.score} 分` : "—"}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>

              {activeQuestion.required ? (
                <p className="mt-3 text-elder text-ink-mute">本题为必答项。</p>
              ) : null}
            </>
          )}
        </div>
      </section>

      <section className="card card-pad space-y-4">
        <h2 className="text-elder-lg font-semibold text-ink">质评意见</h2>
        <textarea
          className="field-input min-h-[120px]"
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          placeholder="填写复核意见，例如：老人复述不清，已当面确认第 3 题。"
          aria-label="质评意见"
        />
        <div className="flex flex-wrap gap-3">
          <BigButton
            size="lg"
            loading={submitting}
            onClick={() => void submitReview("approve")}
          >
            复核通过
          </BigButton>
          <BigButton
            variant="secondary"
            size="lg"
            disabled={submitting}
            onClick={() => void submitReview("correct")}
          >
            提交修正（{corrections.length} 项）
          </BigButton>
        </div>
        <p className="text-elder text-ink-mute">
          复核通过会确认本次作答；提交修正会把修改后的取值写回该评估并自动重新计分。
        </p>
      </section>
    </div>
  );
}
