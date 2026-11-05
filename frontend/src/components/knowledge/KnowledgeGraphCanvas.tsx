"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ZoomIn, ZoomOut, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { KnowledgeEdge, KnowledgeNode } from "@/lib/types";
import {
  GraphLegend,
  computeDegree,
  edgeStyleFor,
  nodeRadius,
  resolveCanvasColors,
  type GraphCanvasColors,
} from "./graphTokens";

/**
 * 知识库关系图谱（力导向图）。
 *
 * 组件来源：`react-force-graph-2d`
 * （https://github.com/vasturiano/react-force-graph · MIT License · v1.29.2），
 * canvas 2D 渲染，不依赖 WebGL。
 *
 * 实现要点（规避该库在 Next.js 15 下的已知问题）：
 * 1. **不向 ForceGraph2D 传 ref**（vasturiano/react-force-graph#551，
 *    根因 react-kapsule#14）。「重置视图」通过变更 `key` 强制重挂载实现；
 * 2. `graphData` 必须 `useMemo` 包裹，否则每次渲染重建图数据、触发布局抖动；
 * 3. 容器必须有**明确高度**，否则父容器高度为 0 时图不渲染（白屏）；
 * 4. `'use client'` ≠ 跳过 SSR：力导向布局在 `useEffect` 挂载后再渲染，
 *    避免服务端与客户端节点位置不一致导致 hydration mismatch；
 * 5. canvas 2D 不支持 `var(--x)`，颜色需在运行时从 CSS 变量解析为真实值。
 */

/** 节点对象（供 force-graph 内部使用，x/y 由库维护） */
interface ForceNode extends KnowledgeNode {
  degree: number;
  x?: number;
  y?: number;
}

interface ForceLink {
  source: string | ForceNode;
  target: string | ForceNode;
  kind: string;
  label?: string;
}

/** d3 力（charge / link 等）的最小类型面：只用到 strength 与 distance */
interface D3ForceLike {
  strength?: (value: number) => unknown;
  distance?: (value: number) => unknown;
}

/**
 * react-force-graph 实例暴露的方法（react-kapsule methodNames）。
 *
 * 这些方法**只能通过 ref 调用**：react-kapsule 会把 methodNames 里的 prop
 * 从「属性透传」中剔除，因此写成 `<Graph d3Force={...} />` 不会生效。
 */
export interface ForceGraphApi {
  /** 取力（无第二参为 getter）/ 替换力 */
  d3Force: (name: string) => D3ForceLike | undefined;
  /** 重新加热模拟，让新的力参数生效 */
  d3ReheatSimulation: () => unknown;
  /** 无参取当前缩放，有参设置缩放 */
  zoom: (k?: number, duration?: number) => unknown;
  /** 按画布适配整张图（duration, padding） */
  zoomToFit: (duration?: number, padding?: number) => unknown;
}

/**
 * 画布留白（px）：zoomToFit 时四周保留的空间。
 * 取 96 是因为节点名标签画在节点下方且长度不定，
 * force-graph 的 bbox 只按节点半径算，不含标签宽度，
 * 留白不足会把边缘标签裁掉。
 */
const CANVAS_PADDING = 96;

/** 标签占位框（图坐标，与缩放无关，因此避让结果对缩放稳定） */
interface LabelBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 标签碰撞避让。
 *
 * 162 个节点里有 28 个病种、21 个量表集中在图中心，
 * 不做避让就会互相压盖。这里按「先到先得」放置：
 * 已被占位的区域不再放新标签。
 *
 * 占位表在每帧开始时清空（`onRenderFramePre`），
 * 因此节点被拖动或缩放后会重新计算，不会残留旧位置。
 */
export function createLabelPlacer() {
  let boxes: LabelBox[] = [];
  return {
    /** 每帧重置占位表 */
    reset() {
      boxes = [];
    },
    /**
     * 尝试放置一个标签。
     * @returns true 表示位置可用（已占位），false 表示与已有标签重叠
     */
    place(
      ctx: CanvasRenderingContext2D,
      text: string,
      centerX: number,
      topY: number,
      fontSize: number,
    ): boolean {
      const w = ctx.measureText(text).width;
      const h = fontSize * 1.15;
      const box: LabelBox = { x: centerX - w / 2, y: topY, w, h };
      const margin = 2;
      for (const other of boxes) {
        if (
          box.x < other.x + other.w + margin &&
          box.x + box.w + margin > other.x &&
          box.y < other.y + other.h + margin &&
          box.y + box.h + margin > other.y
        ) {
          return false;
        }
      }
      boxes.push(box);
      return true;
    },
  };
}

export function KnowledgeGraphCanvas({
  nodes,
  edges,
  selectedId,
  onSelect,
  onResetSignal,
}: {
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  /** 当前选中节点 id（高亮显示） */
  selectedId?: string | null;
  /** 点击节点回调 */
  onSelect: (node: KnowledgeNode) => void;
  /** 重置信号：变化时强制重挂载以重置视图 */
  onResetSignal: number;
}) {
  /** mounted 标记：SSR 阶段不渲染力导向图，避免 hydration 不一致 */
  const [mounted, setMounted] = useState(false);
  /** 画布尺寸 */
  const [size, setSize] = useState({ width: 800, height: 560 });
  /**
   * 力导向图实例引用。
   *
   * 为什么必须用 ref：`d3Force` / `zoomToFit` / `zoom` 在 react-force-graph 里
   * 是 **实例方法**（react-kapsule 的 methodNames），传给 React 组件时会被
   * kapsule 直接忽略（methodNames 里的 prop 不会被当属性调用），
   * 因此只能用 ref 调用。react-kapsule 2.6 通过 useImperativeHandle 暴露这些方法，
   * 在 React 19 下可用。
   */
  const graphRef = useRef<ForceGraphApi | null>(null);
  /** 悬停提示 */
  const [hover, setHover] = useState<{ x: number; y: number; label: string } | null>(null);
  /** 画布实际颜色（从 CSS 变量解析） */
  const [colors, setColors] = useState<GraphCanvasColors | null>(null);
  /** 容器元素引用（用于 ResizeObserver 与颜色解析，非 force-graph 的 ref） */
  const [container, setContainer] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  /** 容器尺寸自适应 + 颜色解析 */
  const containerRef = useCallback((element: HTMLDivElement | null) => {
    setContainer(element);
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const width = entry.contentRect.width;
      const height = entry.contentRect.height;
      if (width > 0 && height > 0) {
        setSize({ width, height });
      }
    });
    observer.observe(element);
  }, []);

  useEffect(() => {
    setColors(resolveCanvasColors(container));
  }, [container]);

  /** 节点度数 */
  const degreeMap = useMemo(() => computeDegree(nodes, edges), [nodes, edges]);

  /** 图数据：必须 useMemo，否则每次渲染重建导致布局抖动 */
  const graphData = useMemo(() => {
    /**
     * 节点顺序 = 标签优先级：
     * 疾病 > 量表 > 症状（症状再按度数降序）。
     * force-graph 按数组顺序绘制节点，标签避让时「先到先得」，
     * 因此把重要节点排在前面，保证密集时优先保留病种名。
     */
    const typePriority: Record<string, number> = { disease: 0, scale: 1, symptom: 2 };
    const graphNodes: ForceNode[] = [...nodes]
      .map((node) => ({
        ...node,
        degree: degreeMap.get(node.id) ?? 0,
      }))
      .sort((a, b) => {
        const p = (typePriority[a.type] ?? 3) - (typePriority[b.type] ?? 3);
        return p !== 0 ? p : b.degree - a.degree;
      });
    const graphLinks: ForceLink[] = edges.map((edge) => ({
      source: edge.source,
      target: edge.target,
      kind: edge.kind,
      label: edge.label,
    }));
    return { nodes: graphNodes, links: graphLinks };
  }, [nodes, edges, degreeMap]);

  /** 选中节点与其邻居 */
  const highlight = useMemo(() => {
    if (!selectedId) return null;
    const neighbors = new Set<string>([selectedId]);
    edges.forEach((edge) => {
      if (edge.source === selectedId) neighbors.add(edge.target);
      if (edge.target === selectedId) neighbors.add(edge.source);
    });
    return neighbors;
  }, [edges, selectedId]);

  /** 以当前缩放为基准放大/缩小（与 zoomToFit 的结果叠加，不丢失适配） */
  const zoomBy = useCallback((factor: number) => {
    const fg = graphRef.current;
    if (!fg) return;
    const current = fg.zoom();
    if (typeof current !== "number") return;
    fg.zoom(current * factor, 220);
  }, []);

  /** 重置视图：重新按画布适配整张图 */
  const resetView = useCallback(() => {
    graphRef.current?.zoomToFit(0, CANVAS_PADDING);
  }, []);

  if (!mounted) {
    return (
      <div className="flex h-[560px] w-full items-center justify-center rounded-clin border border-clin-border bg-clin-muted">
        <p className="text-clin-sm text-clin-fg-muted">正在初始化图谱…</p>
      </div>
    );
  }

  return (
    <div className="relative">
      {/* 工具条：缩放与重置 */}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <GraphLegend />
        <div className="flex items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            aria-label="放大"
            onClick={() => zoomBy(1.25)}
          >
            <ZoomIn className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            aria-label="缩小"
            onClick={() => zoomBy(0.8)}
          >
            <ZoomOut className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            aria-label="重置视图"
            onClick={() => resetView()}
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            重置
          </Button>
        </div>
      </div>

      {/* 画布容器：必须有明确高度，否则图不渲染 */}
      <div
        ref={containerRef}
        className="h-[560px] w-full overflow-hidden rounded-clin border border-clin-border bg-clin-surface"
      >
        {colors ? (
          <ForceGraphInner
            // key 变化时强制重挂载，用于「重新布局」（回到初始力导向状态）
            key={`graph-${onResetSignal}`}
            graphRef={graphRef}
            graphData={graphData}
            width={size.width}
            height={size.height}
            colors={colors}
            highlight={highlight}
            selectedId={selectedId ?? null}
            onSelect={onSelect}
            onHover={setHover}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <p className="text-clin-sm text-clin-fg-muted">正在加载图谱组件…</p>
          </div>
        )}
      </div>

      {hover ? (
        <div
          className="pointer-events-none absolute z-10 rounded-clin-sm bg-clin-primary px-2 py-1 text-clin-xs text-white shadow-clin-shadow"
          style={{ left: hover.x + 12, top: hover.y + 12 }}
        >
          {hover.label}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 力导向图内部组件。
 *
 * 单独拆成一层，是为了让 `react-force-graph-2d` 只在客户端挂载后引入；
 * `key` 变化即可整体重挂载，实现「重新布局」。
 */
function ForceGraphInner({
  graphRef,
  graphData,
  width,
  height,
  colors,
  highlight,
  selectedId,
  onSelect,
  onHover,
}: {
  graphRef: React.RefObject<ForceGraphApi | null>;
  graphData: { nodes: ForceNode[]; links: ForceLink[] };
  width: number;
  height: number;
  colors: GraphCanvasColors;
  highlight: Set<string> | null;
  selectedId: string | null;
  onSelect: (node: KnowledgeNode) => void;
  onHover: (hover: { x: number; y: number; label: string } | null) => void;
}) {
  const [Graph, setGraph] = useState<
    React.ComponentType<Record<string, unknown> & React.RefAttributes<ForceGraphApi>> | null
  >(null);
  /** 标签避让器（每帧重置） */
  const labelPlacerRef = useRef(createLabelPlacer());
  const placeLabel = useCallback(
    (
      ctx: CanvasRenderingContext2D,
      text: string,
      centerX: number,
      topY: number,
      fontSize: number,
    ) => labelPlacerRef.current.place(ctx, text, centerX, topY, fontSize),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    void import("react-force-graph-2d").then((mod) => {
      if (cancelled) return;
      const Component = (mod.default ?? mod) as React.ComponentType<
        Record<string, unknown> & React.RefAttributes<ForceGraphApi>
      >;
      setGraph(() => Component);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * 配置 d3 力并重新加热模拟。
   *
   * d3 默认 charge=-30、link.distance=30，162 个节点会挤成一小团、
   * 标签互相压盖；这里适度加大斥力、拉长连线距离，让层次更清楚。
   * 斥力不能给太大：图谱自然尺寸一旦超过画布就会被裁切（不会自动缩放）。
   * 最终由 zoomToFit 按画布自动适配缩放，因此这里只需保证「疏密可读」。
   *
   * `d3Force` 是实例方法，只能通过 ref 调用（传 prop 会被 kapsule 忽略）。
   */
  useEffect(() => {
    const fg = graphRef.current;
    if (!Graph || !fg) return;
    fg.d3Force("charge")?.strength?.(-150);
    fg.d3Force("link")?.distance?.(55);
    fg.d3ReheatSimulation();
  }, [Graph, graphRef]);

  /** 节点类型 → 实际颜色 */
  const nodeColorOf = useCallback(
    (node: ForceNode) => {
      if (node.type === "disease") return colors.rose;
      if (node.type === "symptom") return colors.accent;
      return colors.fgMuted;
    },
    [colors],
  );

  if (!Graph) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <p className="text-clin-sm text-clin-fg-muted">正在加载图谱组件…</p>
      </div>
    );
  }

  return (
    <Graph
      ref={graphRef}
      graphData={graphData}
      width={width}
      height={height}
      linkColor={(link: ForceLink) => {
        const style = edgeStyleFor(link.kind);
        // CSS 变量在 canvas 中不可用，边颜色由主题色推导
        if (link.kind === "core") return colors.accent;
        if (link.kind === "focus") return colors.fgMuted;
        if (link.kind === "synonym") return colors.borderStrong;
        return colors.fgSubtle;
      }}
      linkWidth={(link: ForceLink) => (link.kind === "core" ? 1.4 : 0.8)}
      linkLineDash={(link: ForceLink) => edgeStyleFor(link.kind).dashArray}
      linkDirectionalParticles={0}
      nodeVal={(node: ForceNode) => nodeRadius(node.degree)}
      nodeColor={(node: ForceNode) => {
        const base = nodeColorOf(node);
        if (!highlight) return base;
        return highlight.has(node.id) ? base : colors.border;
      }}
      nodeLabel={(node: ForceNode) => node.label}
      nodeCanvasObject={(node: ForceNode, ctx: CanvasRenderingContext2D, scale: number) => {
        const radius = nodeRadius(node.degree);
        const isSelected = node.id === selectedId;
        ctx.beginPath();
        ctx.arc(node.x ?? 0, node.y ?? 0, radius, 0, 2 * Math.PI, false);
        ctx.fillStyle = nodeColorOf(node);
        ctx.globalAlpha = highlight && !highlight.has(node.id) ? 0.35 : 1;
        ctx.fill();
        if (isSelected) {
          ctx.globalAlpha = 1;
          ctx.lineWidth = 2 / scale;
          ctx.strokeStyle = colors.fg;
          ctx.stroke();
        }
        ctx.globalAlpha = 1;

        // 标签策略：疾病节点始终标注；症状/量表仅在度数较高时标注。
        // 再叠加「碰撞避让」：与已放置标签重叠的直接跳过，
        // 避免密集区的字互相压盖（force-graph 按节点数组顺序绘制，先到先得）。
        const shouldLabel =
          node.type === "disease" || node.type === "scale" || node.degree >= 10;
        if (shouldLabel) {
          const fontSize = Math.max(9, 11 / scale);
          ctx.font = `${fontSize}px "PingFang SC", "Microsoft YaHei", sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          if (placeLabel(ctx, node.label, node.x ?? 0, (node.y ?? 0) + radius + 2, fontSize)) {
            // 先描白边再填字，保证压在连线上也能看清
            ctx.lineWidth = 3 / scale;
            ctx.strokeStyle = colors.surface;
            ctx.strokeText(node.label, node.x ?? 0, (node.y ?? 0) + radius + 2);
            ctx.fillStyle = colors.fg;
            ctx.fillText(node.label, node.x ?? 0, (node.y ?? 0) + radius + 2);
          }
        }
      }}
      onNodeClick={(node: ForceNode) => onSelect(node)}
      onNodeHover={(node: ForceNode | null) => {
        if (!node) {
          onHover(null);
          return;
        }
        onHover({
          x: node.x ?? 0,
          y: node.y ?? 0,
          label: `${node.label}（${node.group || "—"}）`,
        });
      }}
      /**
       * 引擎停止（节点位置已稳定）后按画布自动适配，
       * 保证图形始终填满画布而不溢出（zoomToFit 同样是实例方法，只能走 ref）。
       */
      onEngineStop={() => {
        onHover(null);
        graphRef.current?.zoomToFit(0, CANVAS_PADDING);
      }}
      /** 每帧开始重置标签占位表，保证避让结果随布局实时更新 */
      onRenderFramePre={() => labelPlacerRef.current.reset()}
      nodeRelSize={4}
      d3AlphaDecay={0.02}
      d3VelocityDecay={0.35}
      cooldownTicks={300}
      warmupTicks={60}
    />
  );
}
