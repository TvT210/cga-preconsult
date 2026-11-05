"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";
import type { KnowledgeEdge, KnowledgeNode } from "@/lib/types";

/**
 * 图谱配色与边样式（**医护端**）。
 *
 * 规范 §2：一个页面只有一个强调色（teal），其余靠灰阶与分隔线组织。
 * 节点按类型区分语义色：量表=slate、症状=teal、疾病=rose；
 * 边按 kind 区分颜色与虚实。颜色取自 `clin.*` token（CSS 变量）。
 */

/** 节点类型 → 颜色（CSS 变量，随 `.theme-clinical` 作用域取 token） */
export const NODE_COLOR: Record<string, string> = {
  scale: "var(--c-fg-muted)",
  symptom: "var(--c-accent)",
  disease: "var(--c-rose)",
};

/** 节点类型 → 中文名 */
export const NODE_TYPE_LABEL: Record<string, string> = {
  disease: "疾病",
  symptom: "症状",
  scale: "量表",
};

/** 边类型 → 颜色与虚实 */
export const EDGE_STYLE: Record<
  string,
  { color: string; dash: number[]; label: string }
> = {
  core: { color: "var(--c-accent)", dash: [], label: "核心症状" },
  secondary: { color: "var(--c-fg-subtle)", dash: [3, 3], label: "次要症状" },
  focus: { color: "var(--c-fg-muted)", dash: [6, 3], label: "关注项" },
  synonym: { color: "var(--c-border-strong)", dash: [1, 3], label: "同义" },
};

/** 边类型 → 中文名（用于图例） */
export const EDGE_KIND_LABEL: Record<string, string> = {
  core: "核心症状",
  secondary: "次要症状",
  focus: "关注项",
  synonym: "同义词",
};

/** 风险等级 → 中文名与徽章色 */
export const RISK_LABEL: Record<string, string> = {
  immediate: "需立即就医",
  urgent: "需尽快就医",
  elective: "择期就诊",
  observe: "居家观察",
};

export const RISK_VARIANT: Record<
  string,
  "destructive" | "warning" | "default" | "secondary"
> = {
  immediate: "destructive",
  urgent: "warning",
  elective: "default",
  observe: "secondary",
};

/** 图谱节点（带度数，供 react-force-graph 使用） */
export interface GraphNode extends KnowledgeNode {
  /** 度数（相连边数），用于节点大小 */
  degree: number;
}

/** react-force-graph 的边数据结构 */
export interface GraphEdge {
  source: string;
  target: string;
  kind: string;
  label?: string;
  item?: string;
  item_text?: string;
}

/** 按度数统计每个节点的连接数 */
export function computeDegree(
  nodes: KnowledgeNode[],
  edges: KnowledgeEdge[],
): Map<string, number> {
  const degree = new Map<string, number>();
  nodes.forEach((node) => degree.set(node.id, 0));
  edges.forEach((edge) => {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  });
  return degree;
}

/** 节点半径：按度数缩放，范围 3~12px */
export function nodeRadius(degree: number): number {
  return Math.min(12, 3 + Math.sqrt(Math.max(0, degree)) * 1.6);
}

/** 过滤：按类型与风险等级保留节点，并同步裁掉悬空边 */
export function filterGraph(
  nodes: KnowledgeNode[],
  edges: KnowledgeEdge[],
  options: { types: string[]; risks: string[] },
): { nodes: KnowledgeNode[]; edges: KnowledgeEdge[] } {
  const typeSet = new Set(options.types);
  const riskSet = new Set(options.risks);

  const keptNodes = nodes.filter((node) => {
    if (!typeSet.has(node.type)) return false;
    if (node.type === "disease" && riskSet.size > 0) {
      return riskSet.has(node.risk ?? "");
    }
    return true;
  });

  const keepIds = new Set(keptNodes.map((node) => node.id));
  const keptEdges = edges.filter(
    (edge) => keepIds.has(edge.source) && keepIds.has(edge.target),
  );

  return { nodes: keptNodes, edges: keptEdges };
}

/** 关键词匹配（后端已支持 keyword 参数，此处用于前端高亮与二次筛选） */
export function matchesKeyword(node: KnowledgeNode, keyword: string): boolean {
  const key = keyword.trim().toLowerCase();
  if (!key) return true;
  return (
    node.label.toLowerCase().includes(key) ||
    node.id.toLowerCase().includes(key) ||
    (node.group ?? "").toLowerCase().includes(key)
  );
}

/** 图例：节点类型与边类型 */
export function GraphLegend({ className }: { className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-center gap-x-4 gap-y-1.5", className)}>
      {Object.entries(NODE_TYPE_LABEL).map(([type, label]) => (
        <span key={type} className="inline-flex items-center gap-1.5 text-clin-xs text-clin-fg-muted">
          <span
            aria-hidden="true"
            className="h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: NODE_COLOR[type] }}
          />
          {label}
        </span>
      ))}
      <span className="text-clin-xs text-clin-fg-subtle">|</span>
      {Object.entries(EDGE_KIND_LABEL).map(([kind, label]) => (
        <span key={kind} className="inline-flex items-center gap-1.5 text-clin-xs text-clin-fg-muted">
          <svg width="18" height="8" aria-hidden="true">
            <line
              x1="0"
              y1="4"
              x2="18"
              y2="4"
              stroke={EDGE_STYLE[kind]?.color ?? "var(--c-border-strong)"}
              strokeWidth="1.5"
              strokeDasharray={
                EDGE_STYLE[kind]?.dash ? EDGE_STYLE[kind].dash.join(",") : undefined
              }
            />
          </svg>
          {label}
        </span>
      ))}
    </div>
  );
}

/** 供图谱画布使用的边样式映射 */
export function edgeStyleFor(kind: string) {
  const style = EDGE_STYLE[kind] ?? EDGE_STYLE.secondary;
  return {
    color: style.color,
    dashArray: style.dash,
  };
}

/**
 * 图谱画布需要的实际颜色值。
 *
 * **canvas 2D 的 `fillStyle` / `strokeStyle` 不支持 `var(--x)` 语法**，
 * 必须先从 DOM 解析出计算后的真实颜色。因此这里在运行时读取
 * `.theme-clinical` 作用域下的 CSS 变量（与规范 §2 的 token 一一对应），
 * 避免在代码里写死 hex。
 */
export interface GraphCanvasColors {
  accent: string;
  rose: string;
  fgMuted: string;
  fgSubtle: string;
  border: string;
  borderStrong: string;
  fg: string;
  /** 画布底色（用于节点标签描边，保证文字压在连线上仍可读） */
  surface: string;
}

/** 画布无法使用 CSS 变量时的兜底色（与 token 取值一致） */
const FALLBACK_COLORS: GraphCanvasColors = {
  accent: "#0d9488",
  rose: "#e11d48",
  fgMuted: "#64748b",
  fgSubtle: "#94a3b8",
  border: "#e2e8f0",
  borderStrong: "#cbd5e1",
  fg: "#0f172a",
  surface: "#ffffff",
};

/**
 * 从指定元素读取 `.theme-clinical` 作用域下的实际颜色。
 *
 * @param element 图谱容器元素（位于 `.theme-clinical` 内）
 */
export function resolveCanvasColors(element: HTMLElement | null): GraphCanvasColors {
  if (!element || typeof window === "undefined") return FALLBACK_COLORS;
  const style = window.getComputedStyle(element);
  const read = (name: string, fallback: string) => {
    const value = style.getPropertyValue(name).trim();
    return value || fallback;
  };
  return {
    accent: read("--c-accent", FALLBACK_COLORS.accent),
    rose: read("--c-rose", FALLBACK_COLORS.rose),
    fgMuted: read("--c-fg-muted", FALLBACK_COLORS.fgMuted),
    fgSubtle: read("--c-fg-subtle", FALLBACK_COLORS.fgSubtle),
    border: read("--c-border", FALLBACK_COLORS.border),
    borderStrong: read("--c-border-strong", FALLBACK_COLORS.borderStrong),
    fg: read("--c-fg", FALLBACK_COLORS.fg),
    surface: read("--c-surface", FALLBACK_COLORS.surface),
  };
}

/** 从图谱节点中找出与某节点直接相连的节点 id 集合 */
export function neighborsOf(
  nodeId: string,
  edges: KnowledgeEdge[],
): Set<string> {
  const result = new Set<string>();
  edges.forEach((edge) => {
    if (edge.source === nodeId) result.add(edge.target);
    if (edge.target === nodeId) result.add(edge.source);
  });
  return result;
}

/** 统计图谱规模 */
export function graphSummary(nodes: KnowledgeNode[], edges: KnowledgeEdge[]) {
  const byType = { disease: 0, symptom: 0, scale: 0 };
  nodes.forEach((node) => {
    if (node.type in byType) {
      byType[node.type as keyof typeof byType] += 1;
    }
  });
  const edgeKinds: Record<string, number> = {};
  edges.forEach((edge) => {
    edgeKinds[edge.kind] = (edgeKinds[edge.kind] ?? 0) + 1;
  });
  return { nodes: nodes.length, edges: edges.length, byType, edgeKinds };
}

/** 供矩阵降级视图使用：症状 × 疾病的关联矩阵 */
export interface MatrixCell {
  disease: string;
  diseaseLabel: string;
  symptom: string;
  symptomLabel: string;
  /** core = 2，secondary = 1，无关联 = 0 */
  weight: number;
}

/** 构建症状 × 疾病矩阵（只含 core / secondary 边） */
export function buildMatrix(
  nodes: KnowledgeNode[],
  edges: KnowledgeEdge[],
): { diseases: { id: string; label: string }[]; symptoms: { id: string; label: string }[]; cells: MatrixCell[] } {
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const diseaseIds = new Set<string>();
  const symptomIds = new Set<string>();
  const cells: MatrixCell[] = [];

  edges.forEach((edge) => {
    if (edge.kind !== "core" && edge.kind !== "secondary") return;
    const source = nodeMap.get(edge.source);
    const target = nodeMap.get(edge.target);
    if (!source || !target) return;

    // 规范：disease → symptom 为症状引用；反向时取反
    const disease = source.type === "disease" ? source : target.type === "disease" ? target : null;
    const symptom = source.type === "symptom" ? source : target.type === "symptom" ? target : null;
    if (!disease || !symptom) return;

    diseaseIds.add(disease.id);
    symptomIds.add(symptom.id);
    cells.push({
      disease: disease.id,
      diseaseLabel: disease.label,
      symptom: symptom.id,
      symptomLabel: symptom.label,
      weight: edge.kind === "core" ? 2 : 1,
    });
  });

  return {
    diseases: Array.from(diseaseIds).map((id) => ({
      id,
      label: nodeMap.get(id)?.label ?? id,
    })),
    symptoms: Array.from(symptomIds).map((id) => ({
      id,
      label: nodeMap.get(id)?.label ?? id,
    })),
    cells,
  };
}
