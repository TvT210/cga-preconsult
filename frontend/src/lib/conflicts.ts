import type { DialogueConflict } from "@/lib/types";

/**
 * 冲突标记的归一口。
 *
 * 后端 `conflict_flags` 是「只提示不修改」的待复核项，四类：
 * 症状 vs 量表、主诉 vs 后续描述、用药 vs 画像、既往史 vs 画像。
 *
 * 两个使用方对「怎么说」的要求相反，所以这里出两个函数：
 * - 老人端（`elderConflictLine`）：只该看到人话，不能出现 `symptoms` 这类英文键；
 * - 医护端（`groupConflicts`）：要能按类分流，并带原句片段去核对。
 */

const KIND_LABEL: Record<string, string> = {
  symptoms: "症状与量表结果",
  complaint: "主诉与后续描述",
  medication: "用药记录",
  history: "既往史",
};

/** 类别中文名。未知类别不能直接透出英文，退回通用说法。 */
export function conflictKindLabel(kind?: string): string {
  if (!kind) return "信息不一致";
  return KIND_LABEL[kind] ?? "信息不一致";
}

/** 冲突类别归类键：旧数据只有 `field`，没有 `kind`。 */
function kindOf(flag: DialogueConflict): string {
  return flag.kind ?? flag.field ?? "";
}

/** 展示值：数组用顿号连，缺省留空而不是打出 `undefined`。 */
export function conflictValueText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map((item) => String(item)).join("、");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** 与记录对不上的那一侧：量表类用 scale_value，画像类用 profile_value。 */
function recordSide(flag: DialogueConflict): string {
  return conflictValueText(flag.profile_value) || conflictValueText(flag.scale_value);
}

/**
 * 老人端的一句话提示。
 *
 * 刻意不写「冲突」「不一致」这类判断词——老人听到「你的回答矛盾了」只会紧张，
 * 该传达的是「这件事我记下来了，医生会看到」。
 */
export function elderConflictLine(flag: DialogueConflict): string {
  const label = conflictKindLabel(kindOf(flag));
  const said = conflictValueText(flag.dialogue_value);
  const recorded = recordSide(flag);
  if (said && recorded) {
    return `${label}：您说的是「${said}」，记录里是「${recorded}」。已记下来请医生核对。`;
  }
  if (said) return `${label}：您说的是「${said}」。已记下来请医生核对。`;
  return `${label}：已记下来请医生核对。`;
}

export interface ConflictGroup {
  kind: string;
  label: string;
  /** 组内是否含需优先核对的项 */
  warn: boolean;
  items: DialogueConflict[];
}

/** 去重键：同一处矛盾在每轮对话里都会重新检出，医护端不该看到十条一样的。 */
function conflictKey(flag: DialogueConflict): string {
  return [
    kindOf(flag),
    conflictValueText(flag.dialogue_value),
    conflictValueText(flag.scale_value),
    conflictValueText(flag.profile_value),
  ].join("|");
}

const KIND_ORDER = ["history", "medication", "complaint", "symptoms"];

/** 医护端聚合：按类别分组、去重，`warn` 组排在前面。 */
export function groupConflicts(flags: DialogueConflict[] | undefined): ConflictGroup[] {
  const seen = new Set<string>();
  const groups = new Map<string, ConflictGroup>();
  for (const flag of flags ?? []) {
    if (!flag) continue;
    const key = conflictKey(flag);
    if (seen.has(key)) continue;
    seen.add(key);
    const kind = kindOf(flag);
    const group = groups.get(kind) ?? {
      kind,
      label: conflictKindLabel(kind),
      warn: false,
      items: [],
    };
    group.items.push(flag);
    if ((flag.severity ?? "warn") === "warn") group.warn = true;
    groups.set(kind, group);
  }
  const rank = (kind: string) => {
    const index = KIND_ORDER.indexOf(kind);
    return index < 0 ? KIND_ORDER.length : index;
  };
  return Array.from(groups.values()).sort(
    (a, b) => Number(b.warn) - Number(a.warn) || rank(a.kind) - rank(b.kind),
  );
}
