"use client";

/**
 * 题目口语化工作台（A-4）。
 *
 * 流程刻意分成两段：**生成候选**与**审批回写**。
 * 生成不会改动任何已评审的题干，候选先进候选池；只有走完审批，
 * 才会写进题库并留版本记录。这样「机器改完就直接上线」这条路径
 * 在界面上不存在，而不是靠人记得别按错。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import type {
  Paged,
  PlainTextDraft,
  PlainTextDraftList,
  ScaleDetail,
  ScaleListItem,
} from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/components/Toast";
import {
  ClinEmpty,
  ClinError,
  ClinLoading,
  ClinPageHeader,
  ClinSection,
} from "@/app/staff/_components/clinical";
import {
  EMPTY_REVIEW_EVIDENCE,
  ReviewEvidenceFields,
  toReviewBody,
  validateReviewEvidence,
  type ReviewEvidenceValue,
} from "@/components/ReviewEvidenceFields";

function toItems<T>(payload: T[] | Paged<T> | null | undefined): T[] {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  return payload.items ?? [];
}

export default function StaffPlainTextPage() {
  const toast = useToast();

  const [scales, setScales] = useState<ScaleListItem[]>([]);
  const [code, setCode] = useState("");
  const [detail, setDetail] = useState<ScaleDetail | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [pool, setPool] = useState<PlainTextDraft[]>([]);
  /** 人工修订后的文案，键为题目编号；未修订时用候选原文 */
  const [edited, setEdited] = useState<Record<string, string>>({});
  const [evidence, setEvidence] = useState<ReviewEvidenceValue>(EMPTY_REVIEW_EVIDENCE);

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const loadScales = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const payload = await api.get<ScaleListItem[] | Paged<ScaleListItem>>("/scales");
      const items = toItems(payload);
      setScales(items);
      setCode((prev) => prev || items[0]?.code || "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "暂时无法获取量表清单。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadScales();
  }, [loadScales]);

  const loadDetail = useCallback(async (target: string) => {
    setBusy(true);
    try {
      const payload = await api.get<ScaleDetail>(`/scales/${encodeURIComponent(target)}`);
      setDetail(payload);
      setSelected([]);
      setEdited({});
      const draft = await api.get<PlainTextDraftList>(
        `/scales/${encodeURIComponent(target)}/plain-text/draft`,
      );
      setPool(draft.items ?? []);
    } catch {
      setDetail(null);
      setPool([]);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (code) void loadDetail(code);
  }, [code, loadDetail]);

  const questions = useMemo(() => {
    const rows: { code: string; text: string; plainText: string }[] = [];
    (detail?.sections ?? []).forEach((section) => {
      (section.questions ?? []).forEach((question) => {
        rows.push({
          code: question.code,
          text: question.text ?? "",
          plainText: question.plain_text ?? "",
        });
      });
    });
    return rows;
  }, [detail]);

  const poolMap = useMemo(() => {
    const map: Record<string, PlainTextDraft> = {};
    pool.forEach((item) => {
      map[item.question_code] = item;
    });
    return map;
  }, [pool]);

  const isAllSelected = questions.length > 0 && selected.length === questions.length;

  const toggleAll = useCallback(() => {
    setSelected((prev) => (prev.length === questions.length ? [] : questions.map((q) => q.code)));
  }, [questions]);

  const generate = useCallback(async () => {
    if (!code) return;
    if (selected.length === 0) {
      toast("请先勾选要改写的题目。", "warning");
      return;
    }
    setBusy(true);
    try {
      const result = await api.post<{ count: number; model: string }>(
        `/scales/${encodeURIComponent(code)}/plain-text/draft`,
        { question_codes: selected },
      );
      toast(`已生成 ${result.count} 条候选，尚未写入题库。`, "success");
      await loadDetail(code);
    } catch {
      /* 错误提示已由 api 层统一处理 */
    } finally {
      setBusy(false);
    }
  }, [code, selected, loadDetail, toast]);

  const apply = useCallback(async () => {
    if (!code || pool.length === 0) return;
    const problem = validateReviewEvidence(evidence);
    if (problem) {
      toast(problem, "warning");
      return;
    }
    const items = pool.map((item) => ({
      question_code: item.question_code,
      plain_text: (edited[item.question_code] ?? item.candidate).trim(),
    }));
    setBusy(true);
    try {
      const result = await api.post<{ applied: number; rejected: { question_code: string; reason: string }[] }>(
        `/scales/${encodeURIComponent(code)}/plain-text/apply`,
        { items, ...toReviewBody(evidence) },
      );
      const rejected = result.rejected.length;
      toast(
        rejected
          ? `已回写 ${result.applied} 题，${rejected} 题未通过护栏检查。`
          : `已回写 ${result.applied} 题，题库与版本记录已更新。`,
        rejected ? "warning" : "success",
      );
      await loadDetail(code);
    } catch {
      /* 错误提示已由 api 层统一处理 */
    } finally {
      setBusy(false);
    }
  }, [code, pool, edited, evidence, loadDetail, toast]);

  if (loading) {
    return <ClinLoading label="正在加载量表…" />;
  }
  if (error) {
    return <ClinError message={error} onRetry={() => void loadScales()} />;
  }

  return (
    <div>
      <ClinPageHeader
        title="题目口语化"
        description="把量表题干改写为老年人能听懂的口语。生成的候选不会改动已评审文案，必须走审批才回写题库；改写只影响展示，不改变题号与计分。"
      />

      <ClinSection title="选择量表">
        <div className="max-w-md">
          <Select value={code} onValueChange={setCode}>
            <SelectTrigger aria-label="选择量表">
              <SelectValue placeholder="请选择量表" />
            </SelectTrigger>
            <SelectContent>
              {scales.map((scale) => (
                <SelectItem key={scale.code} value={scale.code}>
                  {scale.code} · {scale.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {detail ? (
          <p className="mt-3 text-clin-sm text-clin-fg-muted">
            共 {questions.length} 题 · 当前版本 {detail.version} · 评审状态{" "}
            {detail.review_status === "approved" ? "已评审" : "待评审"}
          </p>
        ) : null}
      </ClinSection>

      <ClinSection title="题目与现有口语版">
        {questions.length === 0 ? (
          <ClinEmpty message="该量表暂无题目。" />
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" disabled={busy} onClick={toggleAll}>
                {isAllSelected ? "取消全选" : "全选"}
              </Button>
              <span className="text-clin-xs text-clin-fg-muted">
                已选 {selected.length} / {questions.length} 题
              </span>
              <Button size="sm" disabled={busy || selected.length === 0} onClick={() => void generate()}>
                生成改写候选
              </Button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left">
                <thead className="border-b border-clin-border bg-clin-muted">
                  <tr>
                    <th className="px-3 py-2 text-clin-xs font-medium text-clin-fg-muted">
                      <input
                        type="checkbox"
                        aria-label="全选题目"
                        checked={isAllSelected}
                        onChange={toggleAll}
                      />
                    </th>
                    <th className="px-3 py-2 text-clin-xs font-medium text-clin-fg-muted">题号</th>
                    <th className="px-3 py-2 text-clin-xs font-medium text-clin-fg-muted">原题干</th>
                    <th className="px-3 py-2 text-clin-xs font-medium text-clin-fg-muted">
                      当前口语版
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {questions.map((question) => (
                    <tr
                      key={question.code}
                      className="border-b border-clin-border last:border-0 hover:bg-clin-muted"
                    >
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          aria-label={`选择 ${question.code}`}
                          checked={selected.includes(question.code)}
                          onChange={() =>
                            setSelected((prev) =>
                              prev.includes(question.code)
                                ? prev.filter((item) => item !== question.code)
                                : [...prev, question.code],
                            )
                          }
                        />
                      </td>
                      <td className="px-3 py-2 text-clin-sm tabular-nums text-clin-fg">
                        {question.code}
                      </td>
                      <td className="px-3 py-2 text-clin-sm text-clin-fg">{question.text}</td>
                      <td className="px-3 py-2 text-clin-sm text-clin-fg-muted">
                        {question.plainText || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </ClinSection>

      <ClinSection title="待审批的改写候选">
        {pool.length === 0 ? (
          <ClinEmpty message="暂无候选。勾选题目后点「生成改写候选」。" />
        ) : (
          <div className="space-y-4">
            <p className="rounded-clin border border-clin-border bg-clin-muted px-4 py-3 text-clin-xs text-clin-fg-muted">
              候选只存在候选池里，题库中的口语版没有变化。可以直接修改文案再审批；
              带「症状词」字样的提示会被后端拦下，需先处理。
            </p>
            {pool.map((item) => {
              const value = edited[item.question_code] ?? item.candidate;
              const blocking = item.risk_notes.some((note) => note.includes("症状词"));
              return (
                <div key={item.question_code} className="rounded-clin border border-clin-border p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-clin-sm font-medium tabular-nums text-clin-fg">
                      {item.question_code}
                    </span>
                    <Badge variant={blocking ? "warning" : "success"}>
                      {blocking ? "需处理" : "可回写"}
                    </Badge>
                    <span className="text-clin-xs text-clin-fg-subtle">{item.model}</span>
                  </div>
                  <p className="mt-2 text-clin-xs text-clin-fg-muted">
                    原题干：{item.source_text}
                    {item.current_plain_text ? ` · 现有：${item.current_plain_text}` : ""}
                  </p>
                  <Input
                    className="mt-2"
                    value={value}
                    aria-label={`${item.question_code} 候选文案`}
                    onChange={(event) =>
                      setEdited((prev) => ({ ...prev, [item.question_code]: event.target.value }))
                    }
                  />
                  {item.risk_notes.length ? (
                    <ul className="mt-2 list-disc pl-5 text-clin-xs text-clin-fg-muted">
                      {item.risk_notes.map((note, index) => (
                        <li key={index}>{note}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </ClinSection>

      <ClinSection title="审批并回写题库">
        <ReviewEvidenceFields
          value={evidence}
          onChange={(patch) => setEvidence((prev) => ({ ...prev, ...patch }))}
        />
        <div className="mt-4">
          <Button disabled={busy || pool.length === 0} onClick={() => void apply()}>
            审批通过并回写（{pool.length} 题）
          </Button>
        </div>
      </ClinSection>
    </div>
  );
}
