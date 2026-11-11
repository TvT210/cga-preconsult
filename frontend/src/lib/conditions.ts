import type { AnswerValue, ScaleQuestion } from "./types";

/**
 * 题目级适用条件（题库 `when`）的前端求值器。
 *
 * 为什么要在前端再实现一遍：题库里有分流题（B.15 插管/非插管、B.18 初筛/终筛），
 * 后端计分时已按 `when` 排除不适用条目，但如果前端照旧把所有题都列出来，
 * 老人会被问到与自身路径无关的问题（没插管却要答「机械通气顺应性」）。
 *
 * 语义必须与后端 `app/services/scoring.py` 完全一致，否则会出现
 * 「前端显示的题」和「后端实际计分的题」不一致。对照关系：
 *
 * - `{any: [...]}` / `{all: [...]}` → 任一成立 / 全部成立；
 * - 字符串条目 → 该题阳性（yes/y/true/1/是 或分值 > 0）；
 * - `{question, op, value}` → eq/ne/in 比较选项 value，lt/lte/gt/gte 比较分值。
 *
 * 这里是**只读的展示层过滤**，不参与计分；即使此处漏判，后端 `_item_applies`
 * 仍会把关，结论不会因此出错，最坏是多显示一道题。
 */

const POSITIVE_TOKENS = new Set(["yes", "y", "true", "1", "是"]);

export interface ConditionLeaf {
  question: string;
  op?: "eq" | "ne" | "in" | "lt" | "lte" | "gt" | "gte";
  value?: unknown;
}

export interface ConditionGroup {
  any?: ConditionNode[];
  all?: ConditionNode[];
}

export type ConditionNode = string | ConditionLeaf | ConditionGroup;

/** 单题的作答事实（value 已归一为后端存储形态：多选逗号拼接） */
export interface AnswerFacts {
  value: string;
  score: number | null;
  present: boolean;
}

export type FactsTable = Record<string, AnswerFacts>;

/** 与后端 `_tokens` 一致：多选答案以逗号串存储，比较时拆成词条 */
function tokensOf(facts: AnswerFacts | undefined): string[] {
  if (!facts || !facts.present || !facts.value) return [];
  return facts.value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/** 与后端 `_is_positive` 一致 */
function isPositive(facts: AnswerFacts | undefined): boolean {
  if (!facts || !facts.present) return false;
  if (tokensOf(facts).some((token) => POSITIVE_TOKENS.has(token))) return true;
  return typeof facts.score === "number" && facts.score > 0;
}

function toNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function checkLeaf(leaf: ConditionLeaf, table: FactsTable): boolean {
  const facts = table[leaf.question];
  if (!facts || !facts.present) return false;

  const op = leaf.op ?? "eq";
  const tokens = tokensOf(facts);
  if (op === "eq" || op === "ne" || op === "in") {
    if (op === "eq") {
      return (
        (tokens.length === 1 && tokens[0] === String(leaf.value)) ||
        facts.value === String(leaf.value)
      );
    }
    if (op === "ne") {
      return !(
        (tokens.length === 1 && tokens[0] === String(leaf.value)) ||
        facts.value === String(leaf.value)
      );
    }
    const wanted = Array.isArray(leaf.value)
      ? leaf.value.map(String)
      : [String(leaf.value)];
    return tokens.some((token) => wanted.includes(token));
  }

  // 数值比较一律用分值，与后端一致
  const score = facts.score;
  const threshold = toNumber(leaf.value);
  if (score === null || threshold === null) return false;
  switch (op) {
    case "lt":
      return score < threshold;
    case "lte":
      return score <= threshold;
    case "gt":
      return score > threshold;
    case "gte":
      return score >= threshold;
    default:
      return false;
  }
}

function checkNode(node: ConditionNode, table: FactsTable): boolean {
  if (typeof node === "string") {
    return isPositive(table[node]);
  }
  if (node && typeof node === "object") {
    const group = node as ConditionGroup;
    if (Array.isArray(group.any)) {
      return group.any.some((item) => checkNode(item, table));
    }
    if (Array.isArray(group.all)) {
      return group.all.every((item) => checkNode(item, table));
    }
    if (typeof (node as ConditionLeaf).question === "string") {
      return checkLeaf(node as ConditionLeaf, table);
    }
  }
  return false;
}

/** 求值一个 `when` 条件组（`{any|all: [...]}` 或单个条件） */
export function conditionsHold(
  when: ConditionGroup | ConditionNode | null | undefined,
  table: FactsTable,
): boolean {
  if (!when) return true;
  return checkNode(when as ConditionNode, table);
}

function normalizeValue(value: AnswerValue): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(String).join(",");
  return String(value);
}

/** 取单题分值：与后端 `_apply_answer` 的落分口径保持一致 */
function scoreOf(
  question: ScaleQuestion,
  value: AnswerValue,
  measured: number | undefined,
): number | null {
  const options = question.options ?? [];
  const raw = normalizeValue(value);

  if (question.input_type === "number") {
    // 后端对数值题按 score = float(raw) 存储
    const numeric = toNumber(measured ?? raw);
    return numeric;
  }

  // 实测分档题：填了实测值时按区间定档，档位分值才是本题得分
  if (question.banded_input && typeof measured === "number") {
    const band = options.find((option) => {
      if (option.min === undefined && option.max === undefined) return false;
      const low = option.min ?? Number.NEGATIVE_INFINITY;
      const high = option.max ?? Number.POSITIVE_INFINITY;
      return measured >= low && measured <= high;
    });
    if (band) return band.score ?? null;
  }

  if (question.input_type === "multi") {
    const picked = raw
      ? raw
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean)
      : [];
    if (!picked.length) return null;
    return picked.reduce(
      (sum, item) =>
        sum + (options.find((option) => option.value === item)?.score ?? 0),
      0,
    );
  }

  const matched = options.find((option) => option.value === raw);
  return matched?.score ?? null;
}

/**
 * 把「题目定义 + 当前作答」整理成条件求值所需的事实表。
 *
 * 传入的题目必须是**全量**题目（不能是已过滤的可见列表），
 * 否则被过滤掉的题算不出分值，依赖它的条件会误判。
 */
export function buildFacts(
  questions: ScaleQuestion[],
  answers: Record<string, { value: AnswerValue; measured?: number } | undefined>,
): FactsTable {
  const table: FactsTable = {};
  for (const question of questions) {
    const entry = answers[question.code];
    if (!entry) continue;
    if (Array.isArray(entry.value) && entry.value.length === 0) continue;
    const value = normalizeValue(entry.value);
    const score = scoreOf(question, entry.value, entry.measured);
    table[question.code] = {
      value,
      score,
      present: value !== "" || score !== null,
    };
  }
  return table;
}

/** 这道题在当前作答路径下是否适用 */
export function questionApplies(
  question: ScaleQuestion,
  table: FactsTable,
): boolean {
  if (!question.when) return true;
  return conditionsHold(question.when as ConditionGroup, table);
}

/** 过滤出当前路径下可见的题目（保持原顺序） */
export function applicableQuestions(
  questions: ScaleQuestion[],
  table: FactsTable,
): ScaleQuestion[] {
  return questions.filter((question) => questionApplies(question, table));
}
