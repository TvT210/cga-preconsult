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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/Toast";
import {
  ClinEmpty,
  ClinError,
  ClinLoading,
  ClinPageHeader,
  ClinSection,
} from "@/app/staff/_components/clinical";

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
  /** 实测项的原始测量值（秒数／词语数），仅供复核时对照，不参与改分 */
  const [measuredMap, setMeasuredMap] = useState<Record<string, number | undefined>>({});
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
      const measured: Record<string, number | undefined> = {};
      (detail.answers ?? []).forEach((answer: AssessmentAnswer) => {
        if (!answer?.question_code) return;
        answers[answer.question_code] = answer.value ?? null;
        if (typeof answer.score === "number") {
          scores[answer.question_code] = answer.score;
        }
        if (typeof answer.measured === "number") {
          measured[answer.question_code] = answer.measured;
        }
      });
      setOriginal(answers);
      setOriginalScores(scores);
      setMeasuredMap(measured);
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
    return <ClinLoading label="正在加载作答明细…" />;
  }

  if (error) {
    return <ClinError message={error} onRetry={() => void load()} />;
  }

  if (!session) {
    return <ClinEmpty message="未找到该评估记录。" />;
  }

  const currentScore = (session as unknown as { score?: ReviewScore }).score ?? null;
  const before = scoreBefore ?? currentScore;
  const after = scoreAfter ?? currentScore;
  const scoreChanged =
    before && after && Number(before.total ?? 0) !== Number(after.total ?? 0);

  const activeQuestion =
    questions.find((question) => question.code === activeCode) ?? questions[0] ?? null;

  return (
    <div>
      <ClinPageHeader
        title={`复核评估：${session.scale_name || session.scale_code}`}
        description={`患者编号 ${session.patient_id} · 采集方式 ${
          session.mode === "staff" ? "医护代填" : "老人自填"
        } · 创建时间 ${formatDateTime(session.created_at)}`}
        actions={
          <>
            <Link href={`/staff/patients/${session.patient_id}`}>
              <Button variant="ghost" size="sm">
                查看患者档案
              </Button>
            </Link>
            <Link
              href={`/staff/patients/${session.patient_id}?patient=${session.patient_id}&tab=matching`}
            >
              <Button variant="outline" size="sm">
                匹配与提醒
              </Button>
            </Link>
          </>
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-3 border-b border-clin-border pb-4">
        <Badge
          variant={
            session.status === "reviewed"
              ? "success"
              : session.status === "in_progress"
                ? "warning"
                : "secondary"
          }
        >
          {assessmentStatusLabel(session.status)}
        </Badge>
        {session.proxy?.is_proxy ? (
          <Badge variant="warning">
            家属代答：{session.proxy.proxy_name ?? ""}
            {session.proxy.proxy_relation ? `（${session.proxy.proxy_relation}）` : ""}
          </Badge>
        ) : null}
        {scale?.standard_ref ? (
          <span className="text-clin-xs text-clin-fg-muted">
            标准依据：{scale.standard_ref}
          </span>
        ) : null}
      </div>

      {/* ------------------------- 改分前后对比 ------------------------- */}
      <ClinSection title="改分前后对比">
        <p className="mb-3 text-clin-xs text-clin-fg-muted">
          复核过程中发生改分的样本会计入质控看板的「计分一致率」，复核前后分值不一致即为计分不一致样本。
        </p>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="border-b border-clin-border pb-2">
            <p className="text-clin-xs text-clin-fg-muted">复核前总分</p>
            <p className="mt-0.5 text-[24px] font-semibold leading-none tabular-nums text-clin-fg">
              {before?.total !== undefined ? before.total : "—"}
            </p>
            <p className="mt-1 text-clin-xs text-clin-fg-muted">{before?.level ?? "—"}</p>
          </div>
          <div className="border-b border-clin-border pb-2">
            <p className="text-clin-xs text-clin-fg-muted">复核后总分</p>
            <p className="mt-0.5 text-[24px] font-semibold leading-none tabular-nums text-clin-accent">
              {after?.total !== undefined ? after.total : "—"}
            </p>
            <p className="mt-1 text-clin-xs text-clin-fg-muted">{after?.level ?? "—"}</p>
          </div>
          <div className="border-b border-clin-border pb-2">
            <p className="text-clin-xs text-clin-fg-muted">本次改动</p>
            <p className="mt-0.5 text-[24px] font-semibold leading-none tabular-nums text-clin-fg">
              {corrections.length} 题
            </p>
            <p className="mt-1 text-clin-xs text-clin-fg-muted">
              {scoreChanged
                ? "分值已变化，将计为计分不一致样本"
                : corrections.length > 0
                  ? "分值未变化（仅等级或缺项调整）"
                  : "尚未修改任何题目"}
            </p>
          </div>
        </div>
        {after?.interpretation ? (
          <p className="mt-3 border-l-2 border-clin-accent pl-3 text-clin-sm text-clin-fg-muted">
            判读说明：{after.interpretation}
          </p>
        ) : null}
      </ClinSection>

      {/* ------------------------- 左题右答对照 ------------------------- */}
      <ClinSection title="题目与作答对照">
        <div className="grid gap-5 lg:grid-cols-[280px_1fr]">
          {/* 左：题目列表（紧凑） */}
          <div className="overflow-hidden rounded-clin border border-clin-border bg-clin-surface">
            <div className="border-b border-clin-border bg-clin-muted px-3 py-2">
              <p className="text-clin-sm font-medium text-clin-fg">题目列表</p>
              <p className="mt-0.5 text-clin-xs text-clin-fg-muted">
                共 {questions.length} 题，已修改 {corrections.length} 题
              </p>
            </div>
            {questions.length === 0 ? (
              <p className="px-3 py-6 text-center text-clin-sm text-clin-fg-subtle">
                暂无可复核题目
              </p>
            ) : (
              <ol className="max-h-[520px] overflow-y-auto">
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
                          "flex w-full items-start gap-2 border-b border-clin-border px-3 py-2 text-left transition-colors duration-150",
                          active
                            ? "border-l-2 border-l-clin-accent bg-clin-accent-soft"
                            : "border-l-2 border-l-transparent hover:bg-clin-muted",
                        ].join(" ")}
                      >
                        <span className="text-clin-xs tabular-nums text-clin-fg-subtle">
                          {position + 1}.
                        </span>
                        <span className="flex-1 text-clin-sm text-clin-fg">
                          {question.text}
                          {changed ? (
                            <span className="ml-2">
                              <Badge variant="warning">已改</Badge>
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
          <div className="min-w-0">
            {!activeQuestion ? (
              <ClinEmpty message="该评估暂无可复核的题目。" />
            ) : (
              <>
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <h3 className="text-clin-sm font-medium text-clin-fg">
                    第 {questions.findIndex((item) => item.code === activeQuestion.code) + 1} 题 ·{" "}
                    {activeQuestion.text}
                  </h3>
                  {activeQuestion.plain_text ? (
                    <span className="text-clin-xs text-clin-fg-muted">
                      （{activeQuestion.plain_text}）
                    </span>
                  ) : null}
                </div>

                {/* 原作答 / 现作答：小号表格对照 */}
                <div className="overflow-hidden rounded-clin border border-clin-border">
                  <table className="w-full text-left">
                    <thead className="border-b border-clin-border bg-clin-muted">
                      <tr>
                        <th className="px-3 py-1.5 text-clin-xs font-medium text-clin-fg-muted">
                          对照
                        </th>
                        <th className="px-3 py-1.5 text-clin-xs font-medium text-clin-fg-muted">
                          作答
                        </th>
                        <th className="px-3 py-1.5 text-clin-xs font-medium text-clin-fg-muted">
                          分值
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="border-b border-clin-border">
                        <td className="px-3 py-1.5 text-clin-xs text-clin-fg-muted">
                          原作答
                        </td>
                        <td className="px-3 py-1.5 text-clin-sm text-clin-fg">
                          {displayValue(activeQuestion, original[activeQuestion.code] ?? null)}
                        </td>
                        <td className="px-3 py-1.5 text-clin-sm tabular-nums text-clin-fg-muted">
                          {originalScores[activeQuestion.code] !== undefined
                            ? originalScores[activeQuestion.code]
                            : (optionScore(
                                activeQuestion,
                                original[activeQuestion.code] ?? null,
                              ) ?? "—")}
                        </td>
                      </tr>
                      <tr>
                        <td className="px-3 py-1.5 text-clin-xs text-clin-fg-muted">
                          现作答（可就地修正）
                        </td>
                        <td className="px-3 py-1.5 text-clin-sm text-clin-fg">
                          {displayValue(activeQuestion, edited[activeQuestion.code] ?? null)}
                        </td>
                        <td className="px-3 py-1.5 text-clin-sm tabular-nums text-clin-fg-muted">
                          {optionScore(activeQuestion, edited[activeQuestion.code] ?? null) ?? "—"}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                {/* 选项与分值：小号表格 */}
                <div className="mt-4">
                  {activeQuestion.banded_input &&
                  typeof measuredMap[activeQuestion.code] === "number" ? (
                    <p className="mb-2 rounded-md border border-clin-border bg-clin-bg-subtle px-3 py-2 text-clin-xs text-clin-fg-muted">
                      实测记录：
                      {measuredMap[activeQuestion.code]}
                      {activeQuestion.unit ?? ""}
                      {activeQuestion.unit_hint
                        ? `（${activeQuestion.unit_hint}）`
                        : ""}
                      。当前档位由该数值按标准区间自动裁定，如需改判请直接改选下方档位。
                    </p>
                  ) : null}
                  <Label>选项与分值</Label>
                  {activeQuestion.input_type === "number" ? (
                    <div className="mt-1.5 flex items-center gap-3">
                      <Input
                        type="number"
                        step="any"
                        className="max-w-[180px]"
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
                        <span className="text-clin-xs text-clin-fg-muted">
                          {activeQuestion.unit}
                        </span>
                      ) : null}
                    </div>
                  ) : (
                    <div className="mt-1.5 overflow-hidden rounded-clin border border-clin-border">
                      <table className="w-full text-left">
                        <thead className="border-b border-clin-border bg-clin-muted">
                          <tr>
                            <th className="w-10 px-3 py-1.5" />
                            <th className="px-3 py-1.5 text-clin-xs font-medium text-clin-fg-muted">
                              选项
                            </th>
                            <th className="w-20 px-3 py-1.5 text-clin-xs font-medium text-clin-fg-muted">
                              分值
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {(activeQuestion.options ?? []).map((option) => {
                            const current = edited[activeQuestion.code] ?? null;
                            const selected = Array.isArray(current)
                              ? current.map(String).includes(option.value)
                              : String(current ?? "") === option.value;
                            const inputType =
                              activeQuestion.input_type === "multi" ? "checkbox" : "radio";
                            return (
                              <tr
                                key={option.value}
                                className="border-b border-clin-border transition-colors duration-150 last:border-0 hover:bg-clin-muted"
                              >
                                <td className="px-3 py-1.5">
                                  <input
                                    type={inputType}
                                    className="h-3.5 w-3.5 accent-clin-accent"
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
                                </td>
                                <td
                                  className={
                                    selected
                                      ? "px-3 py-1.5 text-clin-sm text-clin-fg"
                                      : "px-3 py-1.5 text-clin-sm text-clin-fg-muted"
                                  }
                                >
                                  {option.label}
                                </td>
                                <td className="px-3 py-1.5 text-clin-sm tabular-nums text-clin-fg-muted">
                                  {option.score !== undefined ? option.score : "—"}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                {activeQuestion.required ? (
                  <p className="mt-2 text-clin-xs text-clin-fg-subtle">本题为必答项。</p>
                ) : null}
              </>
            )}
          </div>
        </div>
      </ClinSection>

      <ClinSection title="质评意见">
        <textarea
          className="w-full rounded-clin-sm border border-clin-border-strong bg-clin-bg px-3 py-2 text-clin-sm text-clin-fg placeholder:text-clin-fg-subtle focus-visible:border-clin-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-clin-accent"
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          placeholder="填写复核意见，例如：老人复述不清，已当面确认第 3 题。"
          aria-label="质评意见"
          rows={3}
        />
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            size="sm"
            loading={submitting}
            onClick={() => void submitReview("approve")}
          >
            复核通过
          </Button>
          <Button
            variant="outline"
            size="sm"
            loading={submitting}
            onClick={() => void submitReview("correct")}
          >
            提交修正（{corrections.length} 项）
          </Button>
        </div>
        <p className="mt-2 text-clin-xs text-clin-fg-subtle">
          复核通过会确认本次作答；提交修正会把修改后的取值写回该评估并自动重新计分。
        </p>
      </ClinSection>
    </div>
  );
}
