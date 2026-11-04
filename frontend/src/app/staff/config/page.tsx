"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { formatDateTime, reviewStatusLabel } from "@/lib/format";
import type {
  AdminUser,
  MatchThreshold,
  Paged,
  ReviewStatus,
  ScaleListItem,
  ScaleVersion,
} from "@/lib/types";
import { BigButton } from "@/components/BigButton";
import { EmptyState, ErrorState, LoadingState } from "@/components/ErrorState";
import { PageHeader, SectionTitle } from "@/components/PageHeader";
import { StatusBadge } from "@/components/StatusBadge";
import { useToast } from "@/components/Toast";
import { roleLabel } from "@/lib/session";

function toItems<T>(payload: T[] | Paged<T> | null | undefined): T[] {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  return payload.items ?? [];
}

const REVIEW_OPTIONS: { value: ReviewStatus; label: string }[] = [
  { value: "approved", label: "已评审" },
  { value: "draft_pending_medical_review", label: "草稿待医学评审" },
  { value: "deprecated", label: "已废弃" },
];

export default function StaffConfigPage() {
  const toast = useToast();

  const [thresholds, setThresholds] = useState<MatchThreshold[]>([]);
  const [thresholdDraft, setThresholdDraft] = useState<Record<string, number>>({});
  const [scales, setScales] = useState<ScaleListItem[]>([]);
  const [versions, setVersions] = useState<Record<string, ScaleVersion[]>>({});
  const [reviewDraft, setReviewDraft] = useState<Record<string, ReviewStatus>>({});
  const [reviewer, setReviewer] = useState("");
  const [comment, setComment] = useState("");
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [usersError, setUsersError] = useState("");

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [thresholdPayload, scalePayload] = await Promise.all([
        api.get<MatchThreshold[] | Paged<MatchThreshold> | { thresholds?: MatchThreshold[] }>(
          "/matching/thresholds",
        ),
        api.get<ScaleListItem[] | Paged<ScaleListItem>>("/scales"),
      ]);
      // 后端阈值接口返回 {thresholds:[...], weights:[...]}，此处统一取出数组
      const thresholdItems: MatchThreshold[] = Array.isArray(thresholdPayload)
        ? thresholdPayload
        : ((thresholdPayload as { thresholds?: MatchThreshold[] }).thresholds ??
          (thresholdPayload as Paged<MatchThreshold>).items ??
          []);
      setThresholds(thresholdItems);
      setThresholdDraft(
        Object.fromEntries(
          thresholdItems
            .filter((item) => item.id)
            .map((item) => [item.id as string, item.threshold]),
        ),
      );
      const scaleItems = toItems(scalePayload);
      setScales(scaleItems);
      setReviewDraft(
        Object.fromEntries(scaleItems.map((item) => [item.code, item.review_status])),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "暂时无法获取配置数据。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 用户列表仅管理员可见，失败时给出提示而不是阻断整页
  useEffect(() => {
    api
      .get<AdminUser[] | Paged<AdminUser>>("/admin/users")
      .then((payload) => {
        setUsers(toItems(payload));
        setUsersError("");
      })
      .catch((err: unknown) => {
        setUsers([]);
        setUsersError(
          err instanceof Error
            ? err.message
            : "当前账号无权查看用户列表，请联系管理员。",
        );
      });
  }, []);

  /** 载入量表版本历史 */
  const loadVersions = useCallback(async (code: string) => {
    setBusy(true);
    try {
      const payload = await api.get<ScaleVersion[] | Paged<ScaleVersion>>(
        `/scales/${encodeURIComponent(code)}/versions`,
      );
      setVersions((prev) => ({ ...prev, [code]: toItems(payload) }));
    } catch {
      toast("版本历史载入失败。", "warning");
    } finally {
      setBusy(false);
    }
  }, [toast]);

  const saveThreshold = useCallback(
    async (item: MatchThreshold) => {
      if (!item.id) return;
      setBusy(true);
      try {
        await api.put(`/matching/thresholds/${item.id}`, {
          threshold: thresholdDraft[item.id] ?? item.threshold,
        });
        toast("阈值已更新，操作已写入审计日志。", "success");
        await load();
      } catch {
        /* 错误提示已由 api 层统一处理 */
      } finally {
        setBusy(false);
      }
    },
    [thresholdDraft, load, toast],
  );

  const saveReview = useCallback(
    async (code: string) => {
      setBusy(true);
      try {
        await api.put(`/scales/${encodeURIComponent(code)}/review`, {
          review_status: reviewDraft[code],
          reviewer: reviewer.trim() || "医护端操作人",
          comment: comment.trim(),
        });
        toast("量表评审状态已更新。", "success");
        await load();
      } catch {
        /* 错误提示已由 api 层统一处理 */
      } finally {
        setBusy(false);
      }
    },
    [reviewDraft, reviewer, comment, load, toast],
  );

  if (loading) {
    return <LoadingState label="正在加载配置…" />;
  }

  if (error) {
    return <ErrorState message={error} onRetry={() => void load()} />;
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title="配置与质控"
        description="维护就医提醒阈值、量表版本与评审状态，并查看系统用户。阈值与评审变更均由后端写入审计日志。"
      />

      {/* ------------------------------ 阈值配置 ------------------------------ */}
      <section className="card card-pad">
        <SectionTitle title="就医提醒阈值" />
        {thresholds.length === 0 ? (
          <EmptyState message="暂无阈值配置。" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left">
              <thead className="border-b border-slate-200 bg-slate-50">
                <tr>
                  <th className="px-4 py-3 text-elder font-semibold text-ink">适用范围</th>
                  <th className="px-4 py-3 text-elder font-semibold text-ink">病种</th>
                  <th className="px-4 py-3 text-elder font-semibold text-ink">阈值</th>
                  <th className="px-4 py-3 text-elder font-semibold text-ink">提醒等级</th>
                  <th className="px-4 py-3 text-elder font-semibold text-ink">评审状态</th>
                  <th className="px-4 py-3 text-elder font-semibold text-ink">操作</th>
                </tr>
              </thead>
              <tbody>
                {thresholds.map((item) => {
                  const key = item.id ?? "";
                  return (
                    <tr key={key || `${item.scope}-${item.disease_code}`} className="border-b border-slate-100 last:border-0">
                      <td className="px-4 py-3 text-elder text-ink">
                        {item.scope === "global" ? "全局阈值" : item.scope ?? "—"}
                      </td>
                      <td className="px-4 py-3 text-elder text-ink">
                        {item.disease_name || item.disease_code || "全部病种"}
                      </td>
                      <td className="px-4 py-3">
                        <input
                          type="number"
                          className="field-input max-w-[140px]"
                          value={thresholdDraft[key] ?? item.threshold}
                          aria-label="阈值"
                          onChange={(event) =>
                            setThresholdDraft((prev) => ({
                              ...prev,
                              [key]: Number(event.target.value),
                            }))
                          }
                        />
                      </td>
                      <td className="px-4 py-3 text-elder text-ink">{item.level ?? "—"}</td>
                      <td className="px-4 py-3">
                        <StatusBadge
                          label={reviewStatusLabel(item.review_status)}
                          tone={item.review_status === "approved" ? "green" : "amber"}
                        />
                      </td>
                      <td className="px-4 py-3">
                        <BigButton
                          variant="secondary"
                          disabled={busy || !key}
                          onClick={() => void saveThreshold(item)}
                        >
                          保存
                        </BigButton>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ------------------------------ 量表版本与评审 ------------------------------ */}
      <section className="card card-pad">
        <SectionTitle title="量表版本与评审状态" />
        <div className="mb-4 grid gap-4 md:grid-cols-2">
          <div>
            <label className="field-label" htmlFor="reviewer">
              评审人
            </label>
            <input
              id="reviewer"
              className="field-input"
              value={reviewer}
              onChange={(event) => setReviewer(event.target.value)}
              placeholder="请填写评审人姓名"
            />
          </div>
          <div>
            <label className="field-label" htmlFor="review-comment">
              评审意见
            </label>
            <input
              id="review-comment"
              className="field-input"
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              placeholder="例如：已按 WS/T 888—2026 附录 B 逐项核对"
            />
          </div>
        </div>

        {scales.length === 0 ? (
          <EmptyState message="暂无量表。" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-left">
              <thead className="border-b border-slate-200 bg-slate-50">
                <tr>
                  <th className="px-4 py-3 text-elder font-semibold text-ink">编号</th>
                  <th className="px-4 py-3 text-elder font-semibold text-ink">名称</th>
                  <th className="px-4 py-3 text-elder font-semibold text-ink">维度</th>
                  <th className="px-4 py-3 text-elder font-semibold text-ink">当前版本</th>
                  <th className="px-4 py-3 text-elder font-semibold text-ink">评审状态</th>
                  <th className="px-4 py-3 text-elder font-semibold text-ink">操作</th>
                </tr>
              </thead>
              <tbody>
                {scales.map((scale) => (
                  <tr key={scale.code} className="border-b border-slate-100 last:border-0">
                    <td className="px-4 py-3 text-elder text-ink">{scale.code}</td>
                    <td className="px-4 py-3 text-elder text-ink">{scale.name}</td>
                    <td className="px-4 py-3 text-elder text-ink-soft">{scale.dimension}</td>
                    <td className="px-4 py-3 text-elder text-ink-soft">{scale.version}</td>
                    <td className="px-4 py-3">
                      <select
                        className="field-select max-w-[220px]"
                        value={reviewDraft[scale.code] ?? scale.review_status}
                        aria-label={`${scale.code} 评审状态`}
                        onChange={(event) =>
                          setReviewDraft((prev) => ({
                            ...prev,
                            [scale.code]: event.target.value,
                          }))
                        }
                      >
                        {REVIEW_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-2">
                        <BigButton
                          variant="secondary"
                          disabled={busy}
                          onClick={() => void saveReview(scale.code)}
                        >
                          保存评审
                        </BigButton>
                        <BigButton
                          variant="ghost"
                          disabled={busy}
                          onClick={() => void loadVersions(scale.code)}
                        >
                          版本历史
                        </BigButton>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {Object.keys(versions).length ? (
          <div className="mt-5 space-y-4">
            {Object.entries(versions).map(([code, list]) => (
              <div key={code} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                <h3 className="text-elder font-semibold text-ink">{code} 版本历史</h3>
                {list.length === 0 ? (
                  <p className="mt-2 text-elder text-ink-mute">暂无版本记录。</p>
                ) : (
                  <ul className="mt-2 space-y-2">
                    {list.map((version, index) => (
                      <li key={`${code}-${version.version}-${index}`} className="text-elder text-ink-soft">
                        版本 {version.version} · {formatDateTime(version.created_at)}
                        {version.reviewer ? ` · 评审人 ${version.reviewer}` : ""}
                        {version.comment ? ` · ${version.comment}` : ""}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        ) : null}
      </section>

      {/* ------------------------------ 用户管理入口 ------------------------------ */}
      <section className="card card-pad">
        <SectionTitle title="用户管理" />
        {usersError ? (
          <p className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-elder text-amber-900">
            {usersError}
          </p>
        ) : users.length === 0 ? (
          <EmptyState message="暂无用户数据。" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left">
              <thead className="border-b border-slate-200 bg-slate-50">
                <tr>
                  <th className="px-4 py-3 text-elder font-semibold text-ink">账号</th>
                  <th className="px-4 py-3 text-elder font-semibold text-ink">姓名</th>
                  <th className="px-4 py-3 text-elder font-semibold text-ink">角色</th>
                  <th className="px-4 py-3 text-elder font-semibold text-ink">绑定患者</th>
                  <th className="px-4 py-3 text-elder font-semibold text-ink">创建时间</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-4 py-3 text-elder text-ink">{user.username}</td>
                    <td className="px-4 py-3 text-elder text-ink">{user.full_name || "—"}</td>
                    <td className="px-4 py-3 text-elder text-ink">
                      {roleLabel(user.role)}
                    </td>
                    <td className="px-4 py-3 text-elder text-ink-soft">
                      {user.patient_id || "—"}
                    </td>
                    <td className="px-4 py-3 text-elder text-ink-soft">
                      {formatDateTime(user.created_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
