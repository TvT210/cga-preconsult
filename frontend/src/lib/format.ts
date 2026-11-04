/** 展示层格式化工具（界面文案统一简体中文） */

export function formatDateTime(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

export function formatDate(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 由出生日期计算周岁年龄 */
export function ageFromBirthDate(birth?: string | null): string {
  if (!birth) return "—";
  const birthDate = new Date(birth);
  if (Number.isNaN(birthDate.getTime())) return "—";
  const now = new Date();
  let age = now.getFullYear() - birthDate.getFullYear();
  const monthDiff = now.getMonth() - birthDate.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < birthDate.getDate())) {
    age -= 1;
  }
  return age >= 0 ? `${age} 岁` : "—";
}

/** 评估状态中文名 */
export const ASSESSMENT_STATUS_LABEL: Record<string, string> = {
  in_progress: "进行中",
  finished: "已完成",
  reviewed: "已复核",
  abandoned: "已放弃",
};

export function assessmentStatusLabel(status?: string): string {
  if (!status) return "未知";
  return ASSESSMENT_STATUS_LABEL[status] ?? status;
}

/** 量表评审状态中文名 */
export const REVIEW_STATUS_LABEL: Record<string, string> = {
  draft_pending_medical_review: "草稿待医学评审",
  approved: "已评审",
  deprecated: "已废弃",
};

export function reviewStatusLabel(status?: string): string {
  if (!status) return "未知";
  return REVIEW_STATUS_LABEL[status] ?? status;
}

/** 就医提醒等级中文名 */
export const ALERT_LEVEL_LABEL: Record<string, string> = {
  immediate: "立即就医",
  urgent: "尽快就医",
  elective: "择期就诊",
  observe: "居家观察",
};

export function alertLevelLabel(level?: string): string {
  if (!level) return "未分级";
  return ALERT_LEVEL_LABEL[level] ?? level;
}

/**
 * 归一化评估进度。
 * 后端 `progress` 为「已作答题数」，需配合 `total_questions` 才能换算百分比；
 * 也兼容 {answered,total,percent} 对象结构。
 */
export function normalizeProgress(
  progress?: number | { answered?: number; total?: number; percent?: number } | null,
  totalQuestions?: number,
): { answered: number; total: number; percent: number } {
  if (typeof progress === "number") {
    const answered = progress;
    const total = totalQuestions ?? 0;
    const percent = total > 0 ? Math.round((answered / total) * 100) : 0;
    return { answered, total, percent };
  }
  if (progress && typeof progress === "object") {
    const answered = progress.answered ?? 0;
    const total = progress.total ?? totalQuestions ?? 0;
    const percent =
      progress.percent ?? (total > 0 ? Math.round((answered / total) * 100) : 0);
    return { answered, total, percent };
  }
  return { answered: 0, total: totalQuestions ?? 0, percent: 0 };
}

/** 数组字段统一转成逗号分隔文本 */
export function joinList(value?: unknown): string {
  if (Array.isArray(value)) {
    return value
      .map((item) =>
        typeof item === "object" && item !== null
          ? String((item as Record<string, unknown>).name ?? JSON.stringify(item))
          : String(item),
      )
      .join("、");
  }
  if (typeof value === "string" && value.trim()) return value;
  return "—";
}
