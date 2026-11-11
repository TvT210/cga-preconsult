"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useCurrentUser } from "@/lib/useCurrentUser";
import { assessmentStatusLabel } from "@/lib/format";
import { applicableQuestions, buildFacts } from "@/lib/conditions";
import type {
  AnswerValue,
  AssessmentAnswer,
  AssessmentFinishResult,
  AssessmentSession,
  DispatchedBranch,
  Paged,
  ScaleDetail,
  ScaleQuestion,
  ScaleScore,
} from "@/lib/types";
import { BigButton } from "@/components/BigButton";
import { EmptyState, ErrorState, LoadingState } from "@/components/ErrorState";
import { QuestionCard } from "@/components/QuestionCard";
import { useToast } from "@/components/Toast";
import { VoiceBar } from "@/components/VoiceBar";

/** 跳过本题的原因选项（适老化大按钮） */
const SKIP_REASONS = [
  "暂时不方便回答",
  "记不清了",
  "不会回答",
  "其他原因",
];

interface AnswerEntry {
  value: AnswerValue;
  measured?: number;
}

/** 计算单题作答文本与分值，用于结论回溯 */
function scoreForQuestion(
  question: ScaleQuestion,
  entry: AnswerEntry | undefined,
): { text: string; score: number | null } {
  const options = question.options ?? [];
  const recorded =
    entry?.measured !== undefined && entry?.measured !== null
      ? Number(entry.measured)
      : null;
  const selected = entry?.value === null || entry?.value === undefined
    ? ""
    : Array.isArray(entry.value)
      ? entry.value.map((v) => String(v)).join("、")
      : String(entry.value);

  if (recorded === null && !selected) {
    return { text: "未作答", score: null };
  }

  // 实测分档题：显示「实测值（落入档位）」，避免把秒数误读成分值
  if (question.banded_input) {
    const unit = question.unit ?? "";
    if (recorded !== null) {
      const band = options.find((option) => {
        if (option.min === undefined && option.max === undefined) return false;
        const low = option.min ?? Number.NEGATIVE_INFINITY;
        const high = option.max ?? Number.POSITIVE_INFINITY;
        return recorded >= low && recorded <= high;
      });
      const label = band?.label ?? "未落入任何分档区间，需人工核对";
      return {
        text: `实测 ${recorded}${unit}（${label}）`,
        score: band?.score ?? null,
      };
    }
    const fallback = options.find((option) => option.value === selected);
    return { text: fallback?.label ?? selected, score: fallback?.score ?? null };
  }

  if (question.input_type === "number") {
    return {
      text: `${selected || recorded}${question.unit ?? ""}`,
      score: null,
    };
  }
  if (question.input_type === "multi") {
    const picked = Array.isArray(entry?.value)
      ? entry.value.map((v) => String(v))
      : selected
        ? selected.split(",")
        : [];
    if (!picked.length) return { text: "未作答", score: null };
    const labels = picked.map(
      (v) => options.find((option) => option.value === v)?.label ?? v,
    );
    const score = picked.reduce(
      (sum, v) => sum + (options.find((option) => option.value === v)?.score ?? 0),
      0,
    );
    return { text: labels.join("、"), score };
  }
  const matched = options.find((option) => option.value === String(entry?.value));
  return {
    text: matched?.label ?? String(entry?.value ?? ""),
    score: matched?.score ?? null,
  };
}

/** 实测分档题是否已作答：填了数值或选了兜底选项都算 */
function isAnswered(entry: AnswerEntry | undefined): boolean {
  if (!entry) return false;
  if (entry.measured !== undefined && entry.measured !== null) return true;
  if (Array.isArray(entry.value)) return entry.value.length > 0;
  return !(entry.value === null || entry.value === undefined || entry.value === "");
}

export default function ElderScalePage() {
  const params = useParams<{ id: string | string[] }>();
  const router = useRouter();
  const toast = useToast();
  const { user } = useCurrentUser();

  // 路由参数为量表编码，服务端按「患者 + 量表」恢复进度实现断点续填
  const scaleCode = Array.isArray(params.id) ? params.id[0] : params.id;

  const [scale, setScale] = useState<ScaleDetail | null>(null);
  const [session, setSession] = useState<AssessmentSession | null>(null);
  const [questions, setQuestions] = useState<ScaleQuestion[]>([]);
  const [answers, setAnswers] = useState<Record<string, AnswerEntry>>({});
  const [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AssessmentFinishResult | null>(null);
  const [proxyMode, setProxyMode] = useState(false);
  const [proxyName, setProxyName] = useState("");
  const [proxyRelation, setProxyRelation] = useState("");
  const [rate, setRate] = useState(0.9);
  const [skipOpen, setSkipOpen] = useState(false);

  // patient_id 保持后端原样（整数主键）：请求体按原类型发送
  const patientId = user?.patient_id ?? null;

  /** 加载量表与会话（断点续填） */
  const bootstrap = useCallback(async () => {
    if (patientId === null || patientId === "") {
      setError("当前账号没有绑定老人档案，请联系工作人员。");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const detail = await api.get<ScaleDetail>(
        `/scales/${encodeURIComponent(scaleCode)}`,
      );
      setScale(detail);

      const listPayload = await api.get<
        AssessmentSession[] | Paged<AssessmentSession>
      >("/assessments", {
        patient_id: patientId,
        scale_code: scaleCode,
        status: "in_progress",
      });
      const ongoing = Array.isArray(listPayload)
        ? listPayload[0]
        : (listPayload?.items ?? [])[0];

      const active = ongoing
        ? ongoing
        : await api.post<AssessmentSession>("/assessments", {
            patient_id: patientId,
            scale_code: scaleCode,
            mode: "patient",
            ...(proxyMode && proxyName
              ? { proxy_name: proxyName, proxy_relation: proxyRelation }
              : {}),
          });

      const sessionDetail = await api.get<AssessmentSession>(
        `/assessments/${active.id}`,
      );
      setSession(sessionDetail);

      const flatQuestions = (detail.sections ?? []).flatMap(
        (section) => section.questions ?? [],
      );
      const sessionQuestions =
        sessionDetail.questions && sessionDetail.questions.length
          ? sessionDetail.questions
          : flatQuestions;
      const allQuestions = sessionQuestions.length ? sessionQuestions : flatQuestions;
      setQuestions(allQuestions);

      const restored: Record<string, AnswerEntry> = {};
      (sessionDetail.answers ?? []).forEach((answer: AssessmentAnswer) => {
        if (!answer?.question_code) return;
        restored[answer.question_code] = {
          value: answer.value ?? null,
          measured: answer.measured,
        };
      });
      setAnswers(restored);

      // 恢复到服务端记录的当前题目。
      // 注意必须在「已按 when 过滤」的可见题目里找位置：服务端记录的下一题可能是
      // 分流后不适用的题（如未插管的 B15-03），按全量列表定位会错位。
      const current = sessionDetail.current_question;
      const currentCode =
        typeof current === "string"
          ? current
          : current && typeof current === "object"
            ? (current as ScaleQuestion).code
            : undefined;
      if (currentCode) {
        const visible = applicableQuestions(allQuestions, buildFacts(allQuestions, restored));
        const position = visible.findIndex(
          (question) => question.code === currentCode,
        );
        if (position >= 0) setIndex(position);
      }
      if (sessionDetail.proxy?.is_proxy) {
        setProxyMode(true);
        setProxyName(sessionDetail.proxy.proxy_name ?? "");
        setProxyRelation(sessionDetail.proxy.proxy_relation ?? "");
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "暂时无法打开该评估，请稍后重试或联系工作人员。",
      );
    } finally {
      setLoading(false);
    }
    // 仅在量表与患者变化时重新载入；代答信息在提交作答时逐题携带
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patientId, scaleCode]);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  // 按题库 `when` 过滤：只保留当前作答路径下适用的题目（分流题不适用时整题隐藏）。
  // 计分仍由后端按同一套 `when` 把关，这里只影响「问哪些题」。
  const facts = useMemo(() => buildFacts(questions, answers), [questions, answers]);
  const visibleQuestions = useMemo(
    () => applicableQuestions(questions, facts),
    [questions, facts],
  );

  // 作答改变后可见题数可能变少（如把「插管」改成「未插管」），把停留位置收回范围内
  useEffect(() => {
    setIndex((prev) => Math.min(prev, Math.max(0, visibleQuestions.length - 1)));
  }, [visibleQuestions.length]);

  const currentQuestion = visibleQuestions[index];
  const currentEntry = currentQuestion ? answers[currentQuestion.code] : undefined;
  const answeredCount = visibleQuestions.filter((question) =>
    isAnswered(answers[question.code]),
  ).length;

  /** 朗读内容：题目 + 白话解释 + 选项 + 实测施测提示 */
  const speechText = useMemo(() => {
    if (!currentQuestion) return "";
    const parts = [currentQuestion.text];
    if (currentQuestion.plain_text) parts.push(currentQuestion.plain_text);
    if (currentQuestion.banded_input) {
      parts.push(
        currentQuestion.unit_hint ??
          "这道题由工作人员陪同完成，测完把数值填进来就行。",
      );
      const bands = (currentQuestion.options ?? []).filter(
        (option) => option.min !== undefined || option.max !== undefined,
      );
      if (bands.length) parts.push("可选答案：" + bands.map((o) => o.label).join("；"));
    } else if (currentQuestion.options?.length) {
      parts.push("可选答案：" + currentQuestion.options.map((o) => o.label).join("；"));
    }
    if (currentQuestion.unit) parts.push(`单位：${currentQuestion.unit}`);
    return parts.join("。");
  }, [currentQuestion]);

  const buildAnswerBody = useCallback(
    (question: ScaleQuestion, entry: AnswerEntry) => {
      const body: Record<string, unknown> = {
        question_code: question.code,
        value: entry.value,
      };
      if (entry.measured !== undefined) body.measured = entry.measured;
      if (proxyMode) {
        body.proxy_flag = true;
        body.answered_by = proxyName.trim() || "家属";
      }
      return body;
    },
    [proxyMode, proxyName],
  );

  const saveAnswer = useCallback(
    async (question: ScaleQuestion, entry: AnswerEntry) => {
      if (!session) return false;
      if (proxyMode && !proxyName.trim()) {
        toast("请先填写代答人姓名，或取消「由家属代答」。", "warning");
        return false;
      }
      setBusy(true);
      try {
        await api.post(`/assessments/${session.id}/answers`, buildAnswerBody(question, entry));
        setAnswers((prev) => ({ ...prev, [question.code]: entry }));
        return true;
      } catch {
        return false;
      } finally {
        setBusy(false);
      }
    },
    [session, buildAnswerBody, proxyMode, proxyName, toast],
  );

  const finishAssessment = useCallback(async () => {
    if (!session) return;
    setBusy(true);
    try {
      const finishResult = await api.post<AssessmentFinishResult>(
        `/assessments/${session.id}/finish`,
      );
      setResult(finishResult);
    } catch {
      /* 错误提示已由 api 层统一处理 */
    } finally {
      setBusy(false);
    }
  }, [session]);

  /**
   * 推进到下一道可见题。
   *
   * 不能用 `index + 1` 直接推进：答完分流题后可见题目集合会变（B.15 选「未插管」
   * 后插管项消失，B.18 初筛出现阳性后终筛项才出现），此时下标会错位。
   * 这里先用「作答后的答案」重算可见列表，再按题目编码定位下一题。
   *
   * @returns false 表示当前已是最后一题，调用方应结束评估
   */
  const advanceToNext = useCallback(
    (code: string, nextAnswers: Record<string, AnswerEntry>): boolean => {
      const nextVisible = applicableQuestions(questions, buildFacts(questions, nextAnswers));
      const position = nextVisible.findIndex((question) => question.code === code);
      if (position < 0) {
        setIndex(0);
        return true;
      }
      if (position >= nextVisible.length - 1) return false;
      setIndex(position + 1);
      return true;
    },
    [questions],
  );

  const handleNext = useCallback(async () => {
    if (!currentQuestion || !session) return;
    const entry = answers[currentQuestion.code];
    // 实测分档题只填数值时 value 为 null，不能据此判为未作答
    if (!isAnswered(entry)) {
      toast("请先选择答案，或点「跳过本题」。", "warning");
      return;
    }
    const saved = await saveAnswer(currentQuestion, entry);
    if (!saved) return;

    const nextAnswers = { ...answers, [currentQuestion.code]: entry };
    if (!advanceToNext(currentQuestion.code, nextAnswers)) {
      await finishAssessment();
    }
  }, [
    currentQuestion,
    session,
    answers,
    saveAnswer,
    finishAssessment,
    advanceToNext,
    toast,
  ]);

  const handleSkip = useCallback(
    async (reason: string) => {
      if (!currentQuestion || !session) return;
      setBusy(true);
      try {
        await api.post(`/assessments/${session.id}/skip`, {
          question_code: currentQuestion.code,
          reason,
        });
        setSkipOpen(false);
        // 跳过的题目没有取值，适用条件不变，可见集合与当前一致
        if (!advanceToNext(currentQuestion.code, answers)) {
          await finishAssessment();
        }
      } catch {
        /* 错误提示已由 api 层统一处理 */
      } finally {
        setBusy(false);
      }
    },
    [currentQuestion, session, answers, advanceToNext, finishAssessment],
  );

  const handlePause = useCallback(async () => {
    if (currentQuestion) {
      const entry = answers[currentQuestion.code];
      if (isAnswered(entry)) {
        await saveAnswer(currentQuestion, entry);
      }
    }
    toast("已暂停并保存进度，下次可以继续填写。", "success");
    router.push("/elder");
  }, [currentQuestion, answers, saveAnswer, router, toast]);

  /* ------------------------------ 判读结果 ------------------------------ */

  if (loading) {
    return (
      <div className="space-y-5">
        <LoadingState label="正在打开评估问卷…" />
      </div>
    );
  }

  if (error) {
    return <ErrorState message={error} onRetry={() => void bootstrap()} />;
  }

  if (result) {
    const score = result.scores?.[0];
    return (
      <div className="space-y-6">
        <h1 className="text-elder-2xl font-bold text-ink">评估结果</h1>
        <ResultPanel
          score={score}
          result={result}
          scale={scale}
          answers={answers}
          questions={visibleQuestions}
        />
        <div className="flex flex-wrap gap-3">
          <Link href="/elder">
            <BigButton size="lg">返回首页</BigButton>
          </Link>
          <Link href="/elder/report">
            <BigButton variant="secondary" size="lg">
              查看我的报告
            </BigButton>
          </Link>
        </div>
      </div>
    );
  }

  if (!scale || !session || !currentQuestion) {
    return (
      <EmptyState message="该量表暂无可填写的题目，或本次评估没有需要您回答的项目。" />
    );
  }

  const percent = visibleQuestions.length
    ? Math.round((index / visibleQuestions.length) * 100)
    : 0;

  return (
    <div className="space-y-6">
      <header className="card card-pad">
        <h1 className="text-elder-2xl font-bold text-ink">{scale.name}</h1>
        <p className="mt-2 text-elder text-ink-soft">
          所属维度：{scale.dimension} · 采集方式：{scale.method} · 本次需回答{" "}
          {visibleQuestions.length} 题
        </p>
        {scale.standard_ref ? (
          <p className="mt-1 text-elder text-ink-mute">标准依据：{scale.standard_ref}</p>
        ) : null}

        <div className="mt-4">
          <div className="flex items-center justify-between text-elder text-ink-soft">
            <span>
              进度：第 {index + 1} 题 / 共 {visibleQuestions.length} 题
            </span>
            <span>已作答 {answeredCount} 题</span>
          </div>
          <div className="mt-2 h-4 w-full overflow-hidden rounded-full bg-slate-200">
            <div
              className="h-full rounded-full bg-medical-700 transition-all"
              style={{ width: `${percent}%` }}
              role="progressbar"
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
            />
          </div>
          {session.status && session.status !== "in_progress" ? (
            <p className="mt-2 text-elder text-ink-soft">
              当前会话状态：{assessmentStatusLabel(session.status)}
            </p>
          ) : null}
        </div>
      </header>

      <VoiceBar
        speechText={speechText}
        rate={rate}
        onRateChange={setRate}
        allowInput={
          currentQuestion.input_type === "number" || Boolean(currentQuestion.banded_input)
        }
        onTranscript={(text) => {
          const numeric = text.replace(/[^\d.]/g, "");
          if (!numeric) return;
          // 实测分档题说出的数值是「实测值」，须交给服务端落档，不能当选项值
          if (currentQuestion.banded_input) {
            setAnswers((prev) => ({
              ...prev,
              [currentQuestion.code]: { value: null, measured: Number(numeric) },
            }));
            return;
          }
          if (currentQuestion.input_type === "number") {
            setAnswers((prev) => ({
              ...prev,
              [currentQuestion.code]: {
                ...(prev[currentQuestion.code] ?? { value: null }),
                value: Number(numeric),
              },
            }));
          }
        }}
      />

      <QuestionCard
        question={currentQuestion}
        index={index + 1}
        total={visibleQuestions.length}
        value={currentEntry?.value ?? null}
        measured={currentEntry?.measured}
        isProxy={proxyMode}
        onChange={(value, measured) => {
          setAnswers((prev) => ({
            ...prev,
            [currentQuestion.code]: { value, measured },
          }));
        }}
      />

      {/* 家属代答 */}
      <section className="card card-pad space-y-4">
        <label className="flex min-h-btn items-center gap-3 text-elder font-semibold text-ink">
          <input
            type="checkbox"
            className="h-7 w-7"
            checked={proxyMode}
            onChange={(event) => setProxyMode(event.target.checked)}
          />
          由家属代答
        </label>
        {proxyMode ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="field-label" htmlFor="proxy-name">
                代答人姓名
              </label>
              <input
                id="proxy-name"
                className="field-input"
                value={proxyName}
                onChange={(event) => setProxyName(event.target.value)}
                placeholder="请填写代答人姓名"
              />
            </div>
            <div>
              <label className="field-label" htmlFor="proxy-relation">
                与老人关系
              </label>
              <input
                id="proxy-relation"
                className="field-input"
                value={proxyRelation}
                onChange={(event) => setProxyRelation(event.target.value)}
                placeholder="如：女儿、儿子、护工"
              />
            </div>
          </div>
        ) : null}
      </section>

      {/* 操作区 */}
      <section className="card card-pad space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <BigButton
            variant="secondary"
            size="lg"
            disabled={index === 0 || busy}
            onClick={() => setIndex((prev) => Math.max(0, prev - 1))}
          >
            上一题
          </BigButton>
          <BigButton
            size="lg"
            disabled={busy}
            loading={busy && index === visibleQuestions.length - 1}
            onClick={() => void handleNext()}
          >
            {index >= visibleQuestions.length - 1 ? "完成评估" : "下一题"}
          </BigButton>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <BigButton
            variant="warning"
            size="lg"
            disabled={busy}
            onClick={() => setSkipOpen(true)}
          >
            跳过本题
          </BigButton>
          <BigButton variant="ghost" size="lg" disabled={busy} onClick={() => void handlePause()}>
            暂停并退出
          </BigButton>
        </div>
        <p className="text-elder text-ink-mute">
          可以随时暂停退出，进度会自动保存，下次进入可继续填写。
        </p>
      </section>

      {skipOpen ? (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 px-4"
          role="dialog"
          aria-modal="true"
          aria-label="选择跳过原因"
        >
          <div className="card card-pad w-full max-w-xl space-y-4">
            <h2 className="text-elder-xl font-semibold text-ink">这道题先跳过</h2>
            <p className="text-elder text-ink-soft">
              跳过的题目会记为缺项，由工作人员在复核时补充确认。
            </p>
            <div className="space-y-3">
              {SKIP_REASONS.map((reason) => (
                <BigButton
                  key={reason}
                  variant="secondary"
                  size="lg"
                  fullWidth
                  disabled={busy}
                  onClick={() => void handleSkip(reason)}
                >
                  {reason}
                </BigButton>
              ))}
              <BigButton
                variant="ghost"
                size="lg"
                fullWidth
                onClick={() => setSkipOpen(false)}
              >
                返回本题
              </BigButton>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** 判读结果面板：总分、等级、结论、阳性项与逐题依据 */
/** 派发条目的一句话状态说明：让老人清楚「为什么多了这份量表」 */
function followupStatusText(item: DispatchedBranch): string {
  if (item.status === "skipped") {
    switch (item.skip_reason) {
      case "cycle":
        return "这次评估里已经包含这项内容，不用再重复做。";
      case "no_questions":
        return "这份量表的题目还在补录，暂时做不了。";
      case "scale_missing":
        return "题库里暂时没有这份量表。";
      case "duplicate":
        return "和其他推荐重复，已经合并。";
      default:
        return "这次先不安排。";
    }
  }
  if (item.status === "reused") {
    return item.session_status === "finished"
      ? "这份量表你已经做完了，可以随时回看结果。"
      : "你之前开始填过这份量表，还没填完。";
  }
  return "已为你备好这份量表，想做的时候点下面就能开始。";
}

function ResultPanel({
  score,
  result,
  scale,
  answers,
  questions,
}: {
  score?: ScaleScore;
  result: AssessmentFinishResult;
  scale: ScaleDetail | null;
  answers: Record<string, AnswerEntry>;
  questions: ScaleQuestion[];
}) {
  // 逐题回溯只列本次路径上实际问过的题：分流后不适用的题（未插管时的通气项、
  // 初筛全阴时的终筛项）没有作答也不是缺项，列出来只会让老人误以为漏填。
  const list = questions;

  // 分支派发回执优先；旧数据没有 dispatched 时回退成纯建议列表
  const followups: DispatchedBranch[] = result.dispatched?.length
    ? result.dispatched
    : (result.branches ?? []).map((branch) => ({
        branch_code: branch.branch_code ?? branch.target_scale,
        source_scale: scale?.code ?? "",
        target_scale: branch.target_scale,
        reason: branch.reason,
        status: "dispatched" as const,
        skip_reason: "" as const,
        session_id: null,
        session_status: "",
      }));

  return (
    <div className="space-y-5">
      <section className="card card-pad space-y-3">
        <h2 className="text-elder-xl font-semibold text-ink">判读结果</h2>
        {score ? (
          <>
            <p className="text-elder-2xl font-bold text-ink">
              总分 {score.total} 分 · 等级 {score.level}
            </p>
            {score.interpretation ? (
              <p className="text-elder text-ink">{score.interpretation}</p>
            ) : null}
            {score.explanation ? (
              <p className="text-elder text-ink-soft">{score.explanation}</p>
            ) : null}
            {score.severity ? (
              <p className="text-elder text-ink-soft">严重程度：{score.severity}</p>
            ) : null}
            {score.rule_refs && score.rule_refs.length ? (
              <p className="text-elder text-ink-soft">
                规则依据：{score.rule_refs.join("、")}
              </p>
            ) : null}
          </>
        ) : (
          <p className="text-elder text-ink-soft">本次评估暂未生成判读结论。</p>
        )}

        {result.needs_manual_review ? (
          <p className="rounded-xl border-2 border-amber-300 bg-amber-50 px-4 py-3 text-elder text-amber-900">
            本次评估存在缺项或数据异常，需要工作人员人工复核后才能确认结论。
          </p>
        ) : null}
      </section>

      {score?.flags && score.flags.length ? (
        <section className="card card-pad">
          <h2 className="text-elder-xl font-semibold text-ink">阳性项</h2>
          <ul className="mt-3 space-y-2">
            {score.flags.map((flag) => (
              <li
                key={flag}
                className="rounded-xl border-2 border-amber-300 bg-amber-50 px-4 py-3 text-elder text-amber-900"
              >
                {flag}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {followups.length ? (
        <section className="card card-pad">
          <h2 className="text-elder-xl font-semibold text-ink">建议追加的评估</h2>
          <p className="mt-1 text-elder text-ink-soft">
            筛查发现还有些方面需要进一步了解。加不加做、什么时候做，由你和医生商量决定。
          </p>
          <ul className="mt-3 space-y-3">
            {followups.map((item) => {
              const href = `/elder/scale/${encodeURIComponent(item.target_scale)}`;
              const finishedBefore =
                item.status === "reused" && item.session_status === "finished";
              return (
                <li
                  key={item.branch_code || item.target_scale}
                  className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3"
                >
                  <p className="text-elder font-semibold text-ink">
                    {item.target_name || item.target_scale}
                  </p>
                  {item.reason ? (
                    <p className="mt-1 text-elder text-ink-soft">{item.reason}</p>
                  ) : null}
                  <p className="mt-1 text-elder text-ink-soft">
                    {followupStatusText(item)}
                  </p>
                  {item.status === "skipped" ? null : (
                    <Link href={href} className="mt-3 block">
                      <BigButton size="lg" fullWidth>
                        {finishedBefore
                          ? "查看结果"
                          : item.status === "reused"
                            ? "继续填写"
                            : "开始评估"}
                      </BigButton>
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <section className="card card-pad">
        <h2 className="text-elder-xl font-semibold text-ink">逐题作答与得分</h2>
        <p className="mt-1 text-elder text-ink-soft">
          结论可回溯到每一道题的作答与分值。
        </p>
        <ul className="mt-4 space-y-3">
          {list.map((question, position) => {
            const detail = scoreForQuestion(question, answers[question.code]);
            return (
              <li
                key={question.code}
                className="rounded-xl border border-slate-200 bg-slate-50 p-4"
              >
                <p className="text-elder font-semibold text-ink">
                  第 {position + 1} 题 · {question.text}
                </p>
                <p className="mt-1 text-elder text-ink-soft">
                  你的作答：{detail.text}
                </p>
                <p className="text-elder text-ink-soft">
                  本题得分：
                  {detail.score === null ? "实测项／不计分" : `${detail.score} 分`}
                </p>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
