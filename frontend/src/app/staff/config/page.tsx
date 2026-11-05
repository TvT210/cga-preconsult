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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/components/Toast";
import { roleLabel } from "@/lib/session";
import {
  ClinEmpty,
  ClinError,
  ClinLoading,
  ClinPageHeader,
  ClinSection,
} from "@/app/staff/_components/clinical";

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
  const loadVersions = useCallback(
    async (code: string) => {
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
    },
    [toast],
  );

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
    return <ClinLoading label="正在加载配置…" />;
  }

  if (error) {
    return <ClinError message={error} onRetry={() => void load()} />;
  }

  return (
    <div>
      <ClinPageHeader
        title="配置与质控"
        description="维护就医提醒阈值、量表版本与评审状态，并查看系统用户。阈值与评审变更均由后端写入审计日志。"
      />

      {/* ------------------------------ 阈值配置 ------------------------------ */}
      <ClinSection title="就医提醒阈值">
        {thresholds.length === 0 ? (
          <ClinEmpty message="暂无阈值配置。" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] text-left">
              <thead className="border-b border-clin-border bg-clin-muted">
                <tr>
                  <th className="px-3 py-2 text-clin-xs font-medium text-clin-fg-muted">
                    适用范围
                  </th>
                  <th className="px-3 py-2 text-clin-xs font-medium text-clin-fg-muted">
                    病种
                  </th>
                  <th className="px-3 py-2 text-clin-xs font-medium text-clin-fg-muted">
                    阈值
                  </th>
                  <th className="px-3 py-2 text-clin-xs font-medium text-clin-fg-muted">
                    提醒等级
                  </th>
                  <th className="px-3 py-2 text-clin-xs font-medium text-clin-fg-muted">
                    评审状态
                  </th>
                  <th className="px-3 py-2 text-clin-xs font-medium text-clin-fg-muted">
                    操作
                  </th>
                </tr>
              </thead>
              <tbody>
                {thresholds.map((item) => {
                  const key = item.id ?? "";
                  return (
                    <tr
                      key={key || `${item.scope}-${item.disease_code}`}
                      className="border-b border-clin-border transition-colors duration-150 last:border-0 hover:bg-clin-muted"
                    >
                      <td className="px-3 py-2 text-clin-sm text-clin-fg">
                        {item.scope === "global" ? "全局阈值" : item.scope ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-clin-sm text-clin-fg">
                        {item.disease_name || item.disease_code || "全部病种"}
                      </td>
                      <td className="px-3 py-2">
                        <Input
                          type="number"
                          className="max-w-[120px]"
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
                      <td className="px-3 py-2 text-clin-sm text-clin-fg">{item.level ?? "—"}</td>
                      <td className="px-3 py-2">
                        <Badge
                          variant={item.review_status === "approved" ? "success" : "warning"}
                        >
                          {reviewStatusLabel(item.review_status)}
                        </Badge>
                      </td>
                      <td className="px-3 py-2">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy || !key}
                          onClick={() => void saveThreshold(item)}
                        >
                          保存
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </ClinSection>

      {/* ------------------------------ 量表版本与评审 ------------------------------ */}
      <ClinSection title="量表版本与评审状态">
        <div className="mb-4 grid gap-3 md:grid-cols-2">
          <div>
            <Label htmlFor="reviewer">评审人</Label>
            <Input
              id="reviewer"
              className="mt-1"
              value={reviewer}
              onChange={(event) => setReviewer(event.target.value)}
              placeholder="请填写评审人姓名"
            />
          </div>
          <div>
            <Label htmlFor="review-comment">评审意见</Label>
            <Input
              id="review-comment"
              className="mt-1"
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              placeholder="例如：已按 WS/T 888—2026 附录 B 逐项核对"
            />
          </div>
        </div>

        {scales.length === 0 ? (
          <ClinEmpty message="暂无量表。" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[840px] text-left">
              <thead className="border-b border-clin-border bg-clin-muted">
                <tr>
                  <th className="px-3 py-2 text-clin-xs font-medium text-clin-fg-muted">
                    编号
                  </th>
                  <th className="px-3 py-2 text-clin-xs font-medium text-clin-fg-muted">
                    名称
                  </th>
                  <th className="px-3 py-2 text-clin-xs font-medium text-clin-fg-muted">
                    维度
                  </th>
                  <th className="px-3 py-2 text-clin-xs font-medium text-clin-fg-muted">
                    当前版本
                  </th>
                  <th className="px-3 py-2 text-clin-xs font-medium text-clin-fg-muted">
                    评审状态
                  </th>
                  <th className="px-3 py-2 text-clin-xs font-medium text-clin-fg-muted">
                    操作
                  </th>
                </tr>
              </thead>
              <tbody>
                {scales.map((scale) => (
                  <tr
                    key={scale.code}
                    className="border-b border-clin-border transition-colors duration-150 last:border-0 hover:bg-clin-muted"
                  >
                    <td className="px-3 py-2 text-clin-sm tabular-nums text-clin-fg">
                      {scale.code}
                    </td>
                    <td className="px-3 py-2 text-clin-sm text-clin-fg">{scale.name}</td>
                    <td className="px-3 py-2 text-clin-sm text-clin-fg-muted">
                      {scale.dimension}
                    </td>
                    <td className="px-3 py-2 text-clin-sm tabular-nums text-clin-fg-muted">
                      {scale.version}
                    </td>
                    <td className="px-3 py-2">
                      <Select
                        value={reviewDraft[scale.code] ?? scale.review_status}
                        onValueChange={(value) =>
                          setReviewDraft((prev) => ({
                            ...prev,
                            [scale.code]: value,
                          }))
                        }
                      >
                        <SelectTrigger
                          className="max-w-[200px]"
                          aria-label={`${scale.code} 评审状态`}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {REVIEW_OPTIONS.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => void saveReview(scale.code)}
                        >
                          保存评审
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() => void loadVersions(scale.code)}
                        >
                          版本历史
                        </Button>
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
              <div key={code} className="border-l-2 border-clin-accent pl-3">
                <h3 className="text-clin-sm font-medium text-clin-fg">
                  {code} 版本历史
                </h3>
                {list.length === 0 ? (
                  <p className="mt-1 text-clin-xs text-clin-fg-subtle">暂无版本记录。</p>
                ) : (
                  <ul className="mt-1 space-y-1">
                    {list.map((version, index) => (
                      <li
                        key={`${code}-${version.version}-${index}`}
                        className="text-clin-xs text-clin-fg-muted"
                      >
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
      </ClinSection>

      {/* ------------------------------ 用户管理入口 ------------------------------ */}
      <ClinSection title="用户管理">
        {usersError ? (
          <p className="rounded-clin border border-clin-warning px-4 py-3 text-clin-sm text-clin-fg">
            {usersError}
          </p>
        ) : users.length === 0 ? (
          <ClinEmpty message="暂无用户数据。" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] text-left">
              <thead className="border-b border-clin-border bg-clin-muted">
                <tr>
                  <th className="px-3 py-2 text-clin-xs font-medium text-clin-fg-muted">
                    账号
                  </th>
                  <th className="px-3 py-2 text-clin-xs font-medium text-clin-fg-muted">
                    姓名
                  </th>
                  <th className="px-3 py-2 text-clin-xs font-medium text-clin-fg-muted">
                    角色
                  </th>
                  <th className="px-3 py-2 text-clin-xs font-medium text-clin-fg-muted">
                    绑定患者
                  </th>
                  <th className="px-3 py-2 text-clin-xs font-medium text-clin-fg-muted">
                    创建时间
                  </th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr
                    key={user.id}
                    className="border-b border-clin-border transition-colors duration-150 last:border-0 hover:bg-clin-muted"
                  >
                    <td className="px-3 py-2 text-clin-sm text-clin-fg">{user.username}</td>
                    <td className="px-3 py-2 text-clin-sm text-clin-fg">
                      {user.full_name || "—"}
                    </td>
                    <td className="px-3 py-2 text-clin-sm text-clin-fg">
                      {roleLabel(user.role)}
                    </td>
                    <td className="px-3 py-2 text-clin-sm tabular-nums text-clin-fg-muted">
                      {user.patient_id || "—"}
                    </td>
                    <td className="px-3 py-2 text-clin-sm tabular-nums text-clin-fg-muted">
                      {formatDateTime(user.created_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </ClinSection>
    </div>
  );
}
