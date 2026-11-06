"use client";

/**
 * 医护端知识库 **3D 关系图谱**（对外包装）。
 *
 * three.js 需要 WebGL 上下文，服务端不存在，因此必须 `ssr: false` 动态加载；
 * Next.js 15 只允许在客户端组件里使用 `ssr: false`，所以本文件是 `'use client'`。
 */

import dynamic from "next/dynamic";
import { useMemo } from "react";
import type { KnowledgeEdge, KnowledgeNode } from "@/lib/types";

const KnowledgeGraph3DInner = dynamic(() => import("./KnowledgeGraph3DInner"), {
  ssr: false,
  loading: () => (
    <div className="flex h-[620px] w-full items-center justify-center rounded-clin bg-[#0b1220]">
      <p className="text-clin-sm text-slate-400">正在加载 3D 图谱引擎…</p>
    </div>
  ),
});

export function KnowledgeGraph3D({
  nodes,
  edges,
  showIsolated,
  onShowIsolatedChange,
  onSelect,
}: {
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  /** 是否展示「尚未挂到任何病种」的孤立词条 */
  showIsolated: boolean;
  /** 切换孤立词条开关 */
  onShowIsolatedChange: (next: boolean) => void;
  onSelect?: (node: KnowledgeNode | null) => void;
}) {
  /** 统计规模，用于顶部说明 */
  const stats = useMemo(() => {
    const diseases = nodes.filter((n) => n.type === "disease").length;
    const symptoms = nodes.filter((n) => n.type === "symptom").length;
    const scales = nodes.filter((n) => n.type === "scale").length;
    return { diseases, symptoms, scales };
  }, [nodes]);

  /** 孤立词条数量（度为 0） */
  const isolatedCount = useMemo(() => {
    const degree = new Map<string, number>();
    nodes.forEach((n) => degree.set(n.id, 0));
    edges.forEach((e) => {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    });
    return nodes.filter((n) => (degree.get(n.id) ?? 0) === 0).length;
  }, [nodes, edges]);

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-clin-xs text-clin-fg-muted">
          病种 {stats.diseases} · 症状 {stats.symptoms} · 量表 {stats.scales}
        </p>
        <button
          type="button"
          aria-pressed={showIsolated}
          onClick={() => onShowIsolatedChange(!showIsolated)}
          title="词表中尚未挂到任何病种的条目，默认收起（不参与 3D 布局，否则会被斥力推到极远处）"
          className="rounded-clin-sm border border-clin-border-strong bg-clin-bg px-2 py-1 text-clin-xs text-clin-fg-muted transition-colors hover:bg-clin-muted hover:text-clin-fg"
        >
          无关联词条{isolatedCount > 0 ? `（${isolatedCount}）` : ""}
        </button>
      </div>
      <KnowledgeGraph3DInner
        nodes={nodes}
        edges={edges}
        showIsolated={showIsolated}
        onSelect={onSelect ? (node) => onSelect(node) : undefined}
      />
      <p className="mt-2 text-clin-xs text-clin-fg-subtle">
        左键拖拽可**任意角度旋转**，滚轮缩放，右键平移；
        标签按「距相机由近到远」放置，被遮挡或超出上限的中文标签会自动隐藏。
        随缩放分三档展示：
        <span className="text-clin-fg">
          远景只显示 {stats.diseases} 个病种中的常见者
        </span>
        → 中景加入量表与高连接症状 → 近景显示全部节点。
      </p>
    </div>
  );
}
