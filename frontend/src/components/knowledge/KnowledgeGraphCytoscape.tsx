"use client";

/**
 * 医护端知识库关系图谱（cytoscape.js 实现）。
 *
 * 组件来源：`cytoscape/cytoscape.js`
 * （https://github.com/cytoscape/cytoscape.js · MIT License · v3.34.4），
 * 布局扩展 `cytoscape/cytoscape-fcose`（https://github.com/cytoscape/cytoscape-fcose · MIT · v2.2.0）。
 *
 * 【为什么从 react-force-graph 换到 cytoscape】
 * 1. **画面不会被程序擅自改动**：cytoscape 的布局是「一次性执行、跑完即静止」，
 *    节点位置由用户掌控（可拖拽、可随时重新布局），不存在「引擎冷却结束
 *    自动重排 → 视图突然变形」的问题；
 * 2. **可整理**：节点默认可拖拽，拖完位置保留（不会被下一次渲染重置）；
 * 3. **布局可选**：力导向 / 环形 / 同心圆 / 网格 / 树形 五种布局随用随换；
 * 4. **交互完整**：平移、缩放、框选、点选、悬停提示均为库内建；
 * 5. **零运行时依赖**、Canvas 2D 渲染不依赖 WebGL，且自带 TypeScript 类型。
 *
 * 【实现要点】
 * - cytoscape 是命令式库，**只能在客户端动态 import**（服务端 import 会访问
 *   `document`），因此放在 `useEffect` 里异步加载；
 * - 实例在依赖变化时销毁重建（过滤/搜索会改变节点集合），避免增量 diff 的复杂度；
 * - 画布颜色同样从 CSS 变量解析（cytoscape 的样式值可以是 CSS 变量，但为兼容
 *   导出/截图场景统一解析成真实色值）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Core, ElementDefinition, LayoutOptions } from "cytoscape";
import { LayoutGrid, Maximize2, Network, RefreshCw, RotateCcw, RotateCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { KnowledgeEdge, KnowledgeNode } from "@/lib/types";
import {
  GraphLegend,
  computeDegree,
  resolveCanvasColors,
  type GraphCanvasColors,
} from "./graphTokens";

/** 可选布局 */
const LAYOUTS = [
  { value: "concentric", label: "同心圆" },
  { value: "fcose", label: "力导向" },
  { value: "circle", label: "环形" },
  { value: "grid", label: "网格" },
  { value: "breadthfirst", label: "树形" },
] as const;

type LayoutName = (typeof LAYOUTS)[number]["value"];

/**
 * 类型分层权重（同心圆布局用）：病种最内、量表居中、症状最外。
 * 与知识结构一致：病种是枢纽，症状围绕它，量表在外围。
 */
const TYPE_RANK: Record<string, number> = {
  disease: 3,
  scale: 2,
  symptom: 1,
};

/** 画布高度（px） */
const CANVAS_HEIGHT = 560;

export function KnowledgeGraphCytoscape({
  nodes,
  edges,
  selectedId,
  showIsolated,
  onShowIsolatedChange,
  onSelect,
}: {
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  /** 当前选中节点 id（高亮显示） */
  selectedId?: string | null;
  /** 是否显示「尚未挂到任何病种」的孤立词条（由页面统一控制，2D/3D 共用） */
  showIsolated: boolean;
  /** 切换孤立词条开关 */
  onShowIsolatedChange: (next: boolean) => void;
  /** 点击节点回调；传 null 表示取消选中 */
  onSelect: (node: KnowledgeNode | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);
  /** 布局切换 */
  const [layoutName, setLayoutName] = useState<LayoutName>("fcose");
  /** 悬停提示 */
  const [hover, setHover] = useState<{ x: number; y: number; label: string } | null>(null);
  /** 画布颜色（从 CSS 变量解析，只在实例创建时取一次） */
  const colorsRef = useRef<GraphCanvasColors | null>(null);
  /** 加载中 */
  const [loading, setLoading] = useState(true);

  /** 节点度数（决定节点大小与标签优先级） */
  const degreeMap = useMemo(() => computeDegree(nodes, edges), [nodes, edges]);

  /**
   * 标签显示策略：**只标疾病与量表**，症状一律不常显（悬停/选中时在提示里给出）。
   *
   * 162 个节点里 113 个是症状名，全部标注会糊成一团；
   * 医护真正要认的是「病种」和「量表」，症状按度数决定节点大小即可。
   */
  const labelVisible = useCallback(
    (node: KnowledgeNode) => node.type === "disease" || node.type === "scale",
    [],
  );

  /** 节点直径（px）：按关联度数递增，上限 22 */
  const nodeSize = useCallback((degree: number) => {
    const isolated = degree === 0;
    if (isolated) return 7;
    return Math.round(Math.min(22, 8 + degree * 0.55));
  }, []);

  /** 孤立节点（度为 0）：词表里尚未挂到病种的条目 */
  const isolatedCount = useMemo(
    () => nodes.filter((node) => (degreeMap.get(node.id) ?? 0) === 0).length,
    [nodes, degreeMap],
  );
  /** 组装 cytoscape 元素 */
  const elements = useMemo<ElementDefinition[]>(() => {
    const visibleNodes = showIsolated
      ? nodes
      : nodes.filter((node) => (degreeMap.get(node.id) ?? 0) > 0);
    const nodeEls: ElementDefinition[] = visibleNodes.map((node) => {
      const degree = degreeMap.get(node.id) ?? 0;
      return {
        group: "nodes" as const,
        data: {
          id: node.id,
          label: node.label,
          text: labelVisible(node) ? node.label : "",
          type: node.type,
          typeRank: TYPE_RANK[node.type] ?? 1,
          group: node.group ?? "",
          risk: node.risk ?? "",
          degree,
          size: nodeSize(degree),
        },
      };
    });
    const keptIds = new Set(nodeEls.map((n) => (n.data as { id: string }).id));
    const edgeEls: ElementDefinition[] = edges
      .filter(
        (edge) => keptIds.has(edge.source) && keptIds.has(edge.target),
      )
      .map((edge, index) => ({
        group: "edges" as const,
        data: {
          id: `${edge.source}~${edge.target}~${edge.kind}~${index}`,
          source: edge.source,
          target: edge.target,
          kind: edge.kind,
          label: edge.label ?? "",
        },
      }));
    return [...nodeEls, ...edgeEls];
  }, [nodes, edges, degreeMap, labelVisible, nodeSize, showIsolated]);

  /** 布局参数 */
  const layoutOptions = useCallback(
    (name: LayoutName): LayoutOptions => {
      switch (name) {
        case "circle":
          return {
            name: "circle",
            concentric: (node: any) => node.data("typeRank"),
            spacingFactor: 1.15,
            animate: false,
          } as LayoutOptions;
        case "concentric":
          return {
            name: "concentric",
            // 按**类型**分层：病种在内环、症状在外环，
            // 直接对应「病种—症状—量表」的知识结构，比按度数分层更易读。
            concentric: (node: any) => node.data("typeRank"),
            levelWidth: () => 112,
            minNodeSpacing: 16,
            spacingFactor: 1.05,
            animate: false,
          } as LayoutOptions;
        case "grid":
          return { name: "grid", animate: false } as LayoutOptions;
        case "breadthfirst":
          return {
            name: "breadthfirst",
            directed: false,
            spacingFactor: 1.3,
            avoidOverlap: true,
            animate: false,
          } as LayoutOptions;
        case "fcose":
        default:
          return {
            name: "fcose",
            quality: "default",
            randomize: true,
            animate: false,
            /**
             * 斥力/边长按「自然尺寸≈画布尺寸」标定：
             * 斥力过大 → 图谱远大于画布，取景时被迫缩小，标签读不清；
             * 斥力过小 → 病种枢纽挤成一团。
             * 4000 / 65 是实测下来 117 节点铺满 750×560 画布且标签可读的档位。
             */
            nodeRepulsion: 4000,
            idealEdgeLength: 65,
            nodeOverlap: 26,
            maxIterations: 2500,
            packingFactor: 1.0,
          } as LayoutOptions;
      }
    },
    [],
  );

  /** cytoscape 样式表 */
  const buildStyle = useCallback((c: GraphCanvasColors) => {
    const base = {
      "font-family": '"PingFang SC","Microsoft YaHei",sans-serif',
      "min-zoomed-font-size": 6,
    };
    return [
      {
        selector: "node",
        style: {
          ...base,
          "background-color": c.accent,
          "width": "data(size)",
          "height": "data(size)",
          "label": "data(text)",
          "font-size": 11,
          "color": c.fg,
          "text-valign": "bottom",
          "text-halign": "center",
          "text-margin-y": 4,
          "text-background-color": c.surface,
          "text-background-opacity": 0.85,
          "text-background-padding": "2px",
          "text-background-shape": "roundrectangle",
          "border-width": 0,
          "overlay-opacity": 0,
          "transition-property": "opacity, border-width, border-color",
          "transition-duration": "120ms",
        },
      },
      {
        selector: 'node[type = "disease"]',
        style: { "background-color": c.rose },
      },
      {
        selector: 'node[type = "symptom"]',
        style: { "background-color": c.accent },
      },
      {
        selector: 'node[type = "scale"]',
        style: { "background-color": c.fgMuted },
      },
      /** 尚未挂到任何病种的词条：画小一点、淡一点，不喧宾夺主 */
      {
        selector: 'node[degree = 0]',
        style: { "background-opacity": 0.45, "border-width": 1, "border-color": c.border },
      },
      {
        selector: "node:selected",
        style: { "border-width": 2, "border-color": c.fg },
      },
      {
        selector: "edge",
        style: {
          ...base,
          "width": 1,
          "line-color": c.fgSubtle,
          "curve-style": "bezier",
          "target-arrow-shape": "none",
          "opacity": 0.5,
          "transition-property": "opacity",
          "transition-duration": "120ms",
        },
      },
      {
        selector: 'edge[kind = "core"]',
        style: { "width": 1.6, "line-color": c.accent, "opacity": 0.7 },
      },
      {
        selector: 'edge[kind = "secondary"]',
        style: { "width": 0.8, "line-color": c.fgSubtle },
      },
      {
        selector: 'edge[kind = "focus"]',
        style: { "line-style": "dashed", "line-color": c.fgMuted },
      },
      {
        selector: 'edge[kind = "synonym"]',
        style: { "line-style": "dotted", "line-color": c.borderStrong },
      },
      // 选中节点时淡化无关元素，突出该节点的关联
      { selector: ".dim", style: { "opacity": 0.15 } },
      { selector: "node.dim", style: { "opacity": 0.2 } },
    ] as never;
  }, []);

  /**
   * 实例重建签名：元素集合一变（过滤、搜索、孤立节点开关）就重建，
   * 同一批元素下不重建，避免用户拖拽后的位置被抹掉。
   */
  const signature = useMemo(
    () => elements.map((e) => (e.data as { id: string }).id).join("|"),
    [elements],
  );

  useEffect(() => {
    let disposed = false;
    setLoading(true);

    void (async () => {
      const [cyModule, fcoseModule] = await Promise.all([
        import("cytoscape"),
        import("cytoscape-fcose"),
      ]);
      if (disposed) return;

      // ESM/CJS 互操作：cytoscape 为 `export =` 打包，取 default 兜底整体
      const cytoscape = (cyModule.default ?? cyModule) as typeof import("cytoscape");
      const fcose = (fcoseModule.default ?? fcoseModule) as unknown as Parameters<
        typeof cytoscape.use
      >[0];

      // 注册 fcose 布局（幂等）
      cytoscape.use(fcose);

      const container = containerRef.current;
      if (!container) return;

      // 颜色只解析一次并缓存；放进 state 会让实例 effect 反复重建
      const palette = colorsRef.current ?? resolveCanvasColors(container);
      colorsRef.current = palette;

      const cy = cytoscape({
        container,
        elements,
        style: buildStyle(palette) as never,
        layout: layoutOptions("fcose") as never,
        wheelSensitivity: 0.25,
        minZoom: 0.05,
        maxZoom: 6,
        boxSelectionEnabled: true,
        selectionType: "single",
        autounselectify: false,
      });
      cyRef.current = cy;

      // ---- 交互 ----
      cy.on("tap", "node", (event) => {
        const id = event.target.id();
        const hit = nodes.find((node) => node.id === id);
        if (hit) onSelect(hit);
      });
      cy.on("tap", (event) => {
        if (event.target === cy) onSelect(null);
      });
      cy.on("mouseover", "node", (event) => {
        const node = event.target as any;
        setHover({
          x: event.renderedPosition.x,
          y: event.renderedPosition.y,
          label: `${node.data("label")}（${node.data("group") || "—"}）`,
        });
      });
      cy.on("mouseout", "node", () => setHover(null));
      // 拖拽节点后锁定位置（避免被后续渲染重置）
      cy.on("dragfree", "node", () => {
        cy.layout({ name: "preset", fit: false, animate: false } as never).run();
      });

      // 布局跑完后「一次性」把图缩放到画布范围内；
      // 之后不再自动缩放，用户的平移/缩放不会被程序打断。
      cy.one("layoutstop", () => {
        if (disposed) return;
        cy.fit(undefined, 40);
        setLoading(false);
      });
    })();

    return () => {
      disposed = true;
      cyRef.current?.destroy();
      cyRef.current = null;
    };
    // signature 变化即代表节点集合变化，需要重建实例
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, buildStyle, layoutOptions]);

  /** 选中节点高亮：无关节点与边淡出 */
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.elements().removeClass("dim");
    if (!selectedId) return;
    const selected = cy.getElementById(selectedId);
    if (!selected.length) return;
    const keep = new Set<string>([selectedId]);
    selected.connectedEdges().forEach((edge) => {
      keep.add(edge.source().id());
      keep.add(edge.target().id());
    });
    cy.nodes().forEach((node) => {
      if (!keep.has(node.id())) node.addClass("dim");
    });
    cy.edges().forEach((edge) => {
      const s = edge.source().id();
      const t = edge.target().id();
      if (s !== selectedId && t !== selectedId) edge.addClass("dim");
    });
  }, [selectedId, signature]);

  /** 切换布局（用户显式操作） */
  const runLayout = useCallback(
    (name: LayoutName) => {
      setLayoutName(name);
      const cy = cyRef.current;
      if (!cy) return;
      setLoading(true);
      cy.layout(layoutOptions(name) as never).run();
      cy.one("layoutstop", () => {
        cy.fit(undefined, 40);
        setLoading(false);
      });
    },
    [layoutOptions],
  );

  /** 缩放（以画布中心为锚点） */
  const zoomBy = useCallback((factor: number) => {
    const cy = cyRef.current;
    if (!cy) return;
    const container = containerRef.current;
    if (!container) return;
    cy.zoom({
      level: cy.zoom() * factor,
      position: { x: container.clientWidth / 2, y: container.clientHeight / 2 },
    });
  }, []);

  /** 适应画布 */
  const fitView = useCallback(() => {
    cyRef.current?.fit(undefined, 40);
  }, []);

  /**
   * 旋转整张图（绕图形中心，逆时针 45°）。
   *
   * cytoscape 本身只支持「标签旋转」，没有视图旋转，
   * 这里直接对所有节点坐标做一次旋转变换——对任意布局都成立，
   * 边会自动跟随节点。旋转后可用「适应画布」重新取景。
   */
  const rotateView = useCallback(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const nodes = cy.nodes();
    if (!nodes.length) return;
    const bb = nodes.boundingBox();
    const cx = (bb.x1 + bb.x2) / 2;
    const cyy = (bb.y1 + bb.y2) / 2;
    const rad = (-45 * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    nodes.positions((node: any) => {
      const p = node.position();
      const dx = p.x - cx;
      const dy = p.y - cyy;
      return {
        x: cx + dx * cos - dy * sin,
        y: cyy + dx * sin + dy * cos,
      };
    });
  }, []);

  return (
    <div className="relative">
      {/* 工具条：图例 + 布局选择 + 视图控制 */}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <GraphLegend />
        <div className="flex flex-wrap items-center gap-1.5">
          {/* 布局切换 */}
          <div
            className="flex items-center gap-0.5 rounded-clin-sm border border-clin-border-strong bg-clin-bg p-0.5"
            role="group"
            aria-label="布局方式"
          >
            {LAYOUTS.map((item) => (
              <button
                key={item.value}
                type="button"
                onClick={() => runLayout(item.value)}
                aria-pressed={layoutName === item.value}
                className={cn(
                  "rounded-clin-sm px-2 py-1 text-clin-xs transition-colors",
                  layoutName === item.value
                    ? "bg-clin-primary text-white"
                    : "text-clin-fg-muted hover:bg-clin-muted hover:text-clin-fg",
                )}
              >
                {item.label}
              </button>
            ))}
          </div>

          <Button
            variant={showIsolated ? "default" : "outline"}
            size="sm"
            aria-pressed={showIsolated}
            onClick={() => onShowIsolatedChange(!showIsolated)}
            title="词表中尚未挂到任何病种的条目，默认收起以免干扰图谱"
          >
            <span className="text-clin-xs">
              无关联词条{isolatedCount > 0 ? `（${isolatedCount}）` : ""}
            </span>
          </Button>

          <Button variant="outline" size="sm" aria-label="重新布局" onClick={() => runLayout(layoutName)}>
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            重新布局
          </Button>
          <Button variant="outline" size="sm" aria-label="放大" onClick={() => zoomBy(1.25)}>
            <Search className="h-3.5 w-3.5 rotate-0" aria-hidden="true" />
            <span className="text-clin-xs">放大</span>
          </Button>
          <Button variant="outline" size="sm" aria-label="缩小" onClick={() => zoomBy(0.8)}>
            <RotateCcw className="h-3.5 w-3.5 -scale-x-100" aria-hidden="true" />
            <span className="text-clin-xs">缩小</span>
          </Button>
          <Button variant="outline" size="sm" aria-label="旋转 45 度" onClick={rotateView}>
            <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="text-clin-xs">旋转 45°</span>
          </Button>
          <Button variant="outline" size="sm" aria-label="适应画布" onClick={fitView}>
            <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="text-clin-xs">适应画布</span>
          </Button>
        </div>
      </div>

      {/**
       * 画布容器：**必须是 React 不渲染任何子节点的空 div**。
       *
       * cytoscape 会把自己的多层 canvas 注入这个容器；如果 React 也在
       * 同一个 div 里渲染子节点（遮罩层、提示框），React 的子节点
       * 协调就会把 cytoscape 注入的 canvas 当成自己的旧节点去删，
       * 触发 `NotFoundError: removeChild`，画布被整个摘掉、页面变空白。
       * 所以遮罩与提示框一律作为**兄弟节点**放在外层容器里。
       */}
      <div className="relative">
        <div
          ref={containerRef}
          className="w-full overflow-hidden rounded-clin border border-clin-border bg-clin-surface"
          style={{ height: CANVAS_HEIGHT }}
        />

        {loading ? (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-clin bg-clin-surface/70">
            <p className="text-clin-sm text-clin-fg-muted">正在计算图谱布局…</p>
          </div>
        ) : null}

        {hover ? (
          <div
            className="pointer-events-none absolute z-10 rounded-clin-sm bg-clin-primary px-2 py-1 text-clin-xs text-white shadow-clin-shadow"
            style={{ left: hover.x + 12, top: hover.y + 12 }}
          >
            {hover.label}
          </div>
        ) : null}
      </div>

      <p className="mt-2 text-clin-xs text-clin-fg-subtle">
        <Network className="mr-1 inline h-3 w-3" aria-hidden="true" />
        节点可拖拽调整位置，拖完位置保留；滚轮缩放、拖动空白处平移、框选多节点；
        切换布局会重新排布，「旋转 45°」可绕中心转动整张图，点击「适应画布」一键取景。
      </p>
    </div>
  );
}
