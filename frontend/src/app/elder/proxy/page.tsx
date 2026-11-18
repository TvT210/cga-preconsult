"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { api } from "@/lib/api";
import { proxyNameError } from "@/lib/responder";
import type {
  AssessmentListItem,
  AssessmentSession,
  Paged,
  ScaleListItem,
} from "@/lib/types";
import { BigButton } from "@/components/BigButton";
import { EmptyState, ErrorState, LoadingState } from "@/components/ErrorState";
import { PageHeader } from "@/components/PageHeader";
import { useToast } from "@/components/Toast";
import { useCurrentUser } from "@/lib/useCurrentUser";

function toItems<T>(payload: T[] | Paged<T> | null | undefined): T[] {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  return payload.items ?? [];
}

/**
 * 家属代答独立入口（A-9 / 3.1.6）。
 *
 * 起因：原来代答只是量表页里的一个复选框，家属得先「以老人身份开始答题」才找得到，
 * 而且在不知道要填哪张量表时无从下手。
 *
 * 这里先问清「谁代答、答哪张」，再去建会话；会话一经创建即带 `responder=proxy`，
 * 量表页顶部会一直显示「本次由 XXX 代答」。**填写入口仍然只有量表页那一个**，
 * 不复制第二套答题逻辑。
 */
export default function ElderProxyPage() {
  const router = useRouter();
  const toast = useToast();
  const { user } = useCurrentUser();
  const patientId = user?.patient_id ?? null;

  const [scales, setScales] = useState<ScaleListItem[]>([]);
  const [ongoing, setOngoing] = useState<AssessmentListItem[]>([]);
  const [name, setName] = useState("");
  const [relation, setRelation] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState("");

  const load = useCallback(async () => {
    if (patientId === null || patientId === "") {
      setLoading(false);
      setError("当前账号没有绑定老人档案，请联系工作人员。");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const [scalePayload, assessmentPayload] = await Promise.all([
        api.get<ScaleListItem[] | Paged<ScaleListItem>>("/scales"),
        api.get<AssessmentListItem[] | Paged<AssessmentListItem>>("/assessments", {
          patient_id: patientId,
          status: "in_progress",
        }),
      ]);
      setScales(toItems(scalePayload));
      setOngoing(toItems(assessmentPayload));
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "暂时无法获取量表，请稍后重试或联系工作人员。",
      );
    } finally {
      setLoading(false);
    }
  }, [patientId]);

  useEffect(() => {
    void load();
  }, [load]);

  const ongoingOf = (code: string) =>
    ongoing.find((item) => item.scale_code === code);

  const startProxy = useCallback(
    async (scaleCode: string) => {
      if (patientId === null || patientId === "") return;
      const invalid = proxyNameError("proxy", name);
      if (invalid) {
        toast(invalid, "warning");
        return;
      }
      setStarting(scaleCode);
      try {
        const existing = ongoingOf(scaleCode);
        if (existing) {
          // 已有未完成的会话：改主答人即可，已填内容与逐题来源保持原样
          await api.patch<AssessmentSession>(
            `/assessments/${existing.id}/responder`,
            {
              responder: "proxy",
              proxy_name: name.trim(),
              proxy_relation: relation.trim(),
            },
          );
        } else {
          await api.post<AssessmentSession>("/assessments", {
            patient_id: patientId,
            scale_code: scaleCode,
            mode: "patient",
            responder: "proxy",
            proxy_name: name.trim(),
            proxy_relation: relation.trim(),
          });
        }
        toast("已切换为家属代答，开始后请在旁边协助老人。", "success");
        router.push(`/elder/scale/${encodeURIComponent(scaleCode)}`);
      } catch {
        /* 错误提示已由 api 层统一处理 */
      } finally {
        setStarting("");
      }
    },
    // ongoingOf 依赖 ongoing，放在依赖里保证代答判断用的是最新状态
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [patientId, name, relation, ongoing, router, toast],
  );

  if (loading) {
    return <LoadingState label="正在准备代答入口…" />;
  }
  if (error) {
    return <ErrorState message={error} onRetry={() => void load()} />;
  }

  const nameError = name.trim() ? "" : "请先填写代答人姓名";

  return (
    <div className="space-y-6">
      <PageHeader
        title="家属代答"
        description="如果老人说不清、听不清，可以由家属代为回答。代答的题目会被标记出来，医生复核时能看到哪些内容是家属转述的。"
      />

      <section className="card card-pad space-y-4">
        <h2 className="text-elder-lg font-semibold text-ink">第一步：谁来代答</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="field-label" htmlFor="proxy-entry-name">
              代答人姓名（必填）
            </label>
            <input
              id="proxy-entry-name"
              className="field-input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="请填写你的姓名"
            />
          </div>
          <div>
            <label className="field-label" htmlFor="proxy-entry-relation">
              与老人的关系
            </label>
            <input
              id="proxy-entry-relation"
              className="field-input"
              value={relation}
              onChange={(event) => setRelation(event.target.value)}
              placeholder="如：女儿、儿子、护工"
            />
          </div>
        </div>
        {nameError ? (
          <p className="text-elder text-ink-soft">
            姓名必须填写：医生需要知道这份问卷是谁答的。
          </p>
        ) : (
          <p className="text-elder text-ink-soft">
            将记为：由 {name.trim()}
            {relation.trim() ? `（${relation.trim()}）` : ""} 代答。
          </p>
        )}
      </section>

      <section className="space-y-4">
        <h2 className="text-elder-lg font-semibold text-ink">第二步：选一份要填的问卷</h2>
        {scales.length === 0 ? (
          <EmptyState message="暂无可填写的量表，请联系工作人员安排。" />
        ) : (
          <ul className="grid gap-4 md:grid-cols-2">
            {scales.map((scale) => {
              const session = ongoingOf(scale.code);
              return (
                <li key={scale.code} className="card card-pad flex flex-col gap-3">
                  <h3 className="text-elder-lg font-semibold text-ink">{scale.name}</h3>
                  <p className="text-elder text-ink-soft">
                    共 {scale.item_count} 题 · 采集方式：{scale.method}
                  </p>
                  {session ? (
                    <p className="text-elder text-ink-soft">
                      这份问卷已经开始填了，继续代答会接着上次的进度。
                    </p>
                  ) : null}
                  <BigButton
                    size="lg"
                    fullWidth
                    disabled={Boolean(nameError) || starting !== ""}
                    loading={starting === scale.code}
                    onClick={() => void startProxy(scale.code)}
                  >
                    {session ? "继续代答" : "开始代答"}
                  </BigButton>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
