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

export default function StaffReviewPage() {
  const params = useParams<{ id: string | string[] }>();
  const assessmentId = Array.isArray(params.id) ? params.id[0] : params.id;
  const toast = useToast();

  const [session, setSession] = useState<AssessmentSession | null>(null);
  const [scale, setScale] = useState<ScaleDetail | null>(null);
  const [questions, setQuestions] = useState<ScaleQuestion[]>([]);
  const [original, setOriginal] = useState<Record<string, AnswerValue>>({});
  const [edited, setEdited] = useState<Record<string, AnswerValue>>({});
  const [comment, setComment] = useState("");
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
      (detail.answers ?? []).forEach((answer: AssessmentAnswer) => {
        if (!answer?.question_code) return;
        answers[answer.question_code] = answer.value ?? null;
      });
      setOriginal(answers);
      setEdited(answers);
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
        await api.post(`/assessments/${session.id}/review`, {
          action,
          corrections,
          comment: comment.trim(),
        });
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
            <Link href={`/staff/patients/${session.patient_id}#dialogue`}>
              <BigButton variant="secondary" size="lg">
                对话回放入口
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

      <section className="card card-pad">
        <h2 className="text-elder-lg font-semibold text-ink">作答明细与修正</h2>
        <p className="mt-1 text-elder text-ink-soft">
          修改某题取值后，提交时会作为修正项一并发送给后端复核。
        </p>

        {questions.length === 0 ? (
          <div className="mt-4">
            <EmptyState message="该评估暂无可复核的题目。" />
          </div>
        ) : (
          <ul className="mt-4 space-y-4">
            {questions.map((question, position) => {
              const current = edited[question.code] ?? null;
              const changed = !sameValue(original[question.code] ?? null, current);
              return (
                <li
                  key={question.code}
                  className={[
                    "rounded-xl border-2 p-4",
                    changed ? "border-medical-400 bg-medical-50" : "border-slate-200 bg-white",
                  ].join(" ")}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-elder font-semibold text-ink">
                      第 {position + 1} 题 · {question.text}
                    </p>
                    {changed ? <StatusBadge label="已修改" tone="blue" /> : null}
                  </div>
                  <p className="mt-1 text-elder text-ink-soft">
                    原作答：{displayValue(question, original[question.code] ?? null)}
                  </p>

                  {question.input_type === "number" ? (
                    <div className="mt-3 flex items-center gap-3">
                      <input
                        type="number"
                        step="any"
                        className="field-input max-w-xs"
                        value={current === null || current === undefined ? "" : String(current)}
                        aria-label={`修正第 ${position + 1} 题取值`}
                        onChange={(event) =>
                          setEdited((prev) => ({
                            ...prev,
                            [question.code]:
                              event.target.value === "" ? null : Number(event.target.value),
                          }))
                        }
                      />
                      {question.unit ? (
                        <span className="text-elder text-ink-soft">{question.unit}</span>
                      ) : null}
                    </div>
                  ) : (
                    <div className="mt-3 space-y-2">
                      {(question.options ?? []).map((option) => {
                        const selected = Array.isArray(current)
                          ? current.map(String).includes(option.value)
                          : String(current ?? "") === option.value;
                        const inputType = question.input_type === "multi" ? "checkbox" : "radio";
                        return (
                          <label
                            key={option.value}
                            className="flex min-h-btn items-center gap-3 rounded-xl border border-slate-200 px-4 py-2 text-elder text-ink"
                          >
                            <input
                              type={inputType}
                              className="h-6 w-6"
                              checked={selected}
                              name={`question-${question.code}`}
                              onChange={(event) => {
                                setEdited((prev) => {
                                  if (question.input_type === "multi") {
                                    const raw = prev[question.code];
                                    const list = Array.isArray(raw)
                                      ? raw.map(String)
                                      : [];
                                    const next = event.target.checked
                                      ? [...list, option.value]
                                      : list.filter((item) => item !== option.value);
                                    return { ...prev, [question.code]: next };
                                  }
                                  return { ...prev, [question.code]: option.value };
                                });
                              }}
                            />
                            <span>
                              {option.label}
                              {option.score !== undefined ? `（${option.score} 分）` : ""}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
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
          复核通过会确认本次作答；提交修正会把修改后的取值写回该评估。
        </p>
      </section>
    </div>
  );
}
