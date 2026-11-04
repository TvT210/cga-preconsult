"use client";

import { BigButton } from "./BigButton";
import type { AlertItem, AlertLevel } from "@/lib/types";

const LEVEL_META: Record<string, { label: string; cls: string }> = {
  immediate: { label: "立即就医", cls: "bg-red-100 text-red-800 border-red-300" },
  urgent: { label: "尽快就医", cls: "bg-amber-100 text-amber-900 border-amber-300" },
  elective: { label: "择期就诊", cls: "bg-medical-100 text-medical-800 border-medical-300" },
  observe: { label: "居家观察", cls: "bg-emerald-100 text-emerald-800 border-emerald-300" },
};

export function alertLevelLabel(level: AlertLevel | undefined): string {
  if (!level) return "未分级";
  return LEVEL_META[level]?.label ?? level;
}

const STATUS_LABEL: Record<string, string> = {
  pending: "待处理",
  handled: "已处理",
  closed: "已关闭",
  escalated: "已升级",
};

export function alertStatusLabel(status?: string): string {
  if (!status) return "未知状态";
  return STATUS_LABEL[status] ?? status;
}

/**
 * 就医提醒卡片。提醒固定附带免责声明。
 */
export function AlertCard({
  alert,
  onHandle,
  handling = false,
}: {
  alert: AlertItem;
  /** 医护端处理回调，传入 action 与备注 */
  onHandle?: (action: "ack" | "escalate" | "close", comment: string) => void;
  handling?: boolean;
}) {
  const meta = LEVEL_META[alert.level] ?? {
    label: alert.level ?? "未分级",
    cls: "bg-slate-100 text-ink-soft border-slate-300",
  };

  return (
    <article className="rounded-xl2 border border-slate-200 bg-white p-5 shadow-card">
      <header className="flex flex-wrap items-center gap-3">
        <span className={`rounded-full border-2 px-4 py-1 text-elder font-semibold ${meta.cls}`}>
          {meta.label}
        </span>
        <span className="rounded-full bg-slate-100 px-3 py-1 text-elder text-ink-soft">
          {alertStatusLabel(alert.status)}
        </span>
        {alert.created_at ? (
          <span className="text-elder text-ink-mute">{formatTime(alert.created_at)}</span>
        ) : null}
      </header>

      <p className="mt-3 text-elder-lg leading-relaxed text-ink">{alert.message}</p>

      {alert.department ? (
        <p className="mt-2 text-elder text-ink-soft">建议就诊科室：{alert.department}</p>
      ) : null}

      <p className="mt-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-2 text-elder text-amber-900">
        结果仅供参考，不构成诊断，请及时咨询医生。
      </p>

      {onHandle ? (
        <div className="mt-4 flex flex-wrap gap-3">
          <BigButton
            variant="secondary"
            disabled={handling}
            onClick={() => onHandle("ack", "已阅知")}
          >
            已知晓
          </BigButton>
          <BigButton
            variant="warning"
            disabled={handling}
            onClick={() => onHandle("escalate", "升级处理")}
          >
            升级处理
          </BigButton>
          <BigButton
            variant="ghost"
            disabled={handling}
            onClick={() => onHandle("close", "已关闭")}
          >
            关闭
          </BigButton>
        </div>
      ) : null}
    </article>
  );
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}
