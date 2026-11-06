"use client";

/**
 * 医护端知识库 **3D 关系图谱**（three.js + react-force-graph-3d）。
 *
 * 组件来源：
 * - `vasturiano/react-force-graph-3d`（MIT · v1.29.2）——React 3D 力导向图
 * - `mrdoob/three.js`（MIT · v0.187.0）——WebGL 渲染
 *
 * 【为什么用 3D 而不是 2D】
 * 1. **可自由旋转**：轨道控制器（OrbitControls）支持左键拖拽任意角度旋转、
 *    滚轮缩放、右键平移，比 2D 的平移缩放更符合"三维关系"的直觉；
 * 2. **中文不堆叠**：标签是 **DOM 覆盖层**（不是 canvas 文字），
 *    每帧按「距相机由近到远」贪心占位，屏幕矩形重叠的直接隐藏——
 *    天然实现"前面的节点带中文、后面的隐藏"；
 * 3. **随缩放分级展示**：按相机距离分三档——远景只显示常见病种，
 *    中景加量表与高连接症状，近景显示全部；
 * 4. **密度稀疏**：斥力与连线距离按 3D 拓扑单独标定，
 *    线条不再糊成一片。
 *
 * 【关键实现说明】
 * - 节点与连线的 three 对象由本组件自己创建（`nodeThreeObject` /
 *   `linkThreeObject`），因此**可以逐帧直接改 `visible`**，
 *   实现分级显隐而不必重建图数据、不打断力导向布局。
 * - 标签层是普通 DOM，用 `transform` 直接定位，**不走 React 渲染**，
 *   保证 60fps 下不产生重渲染。
 * - 3D 依赖必须客户端加载（three 的 WebGL 上下文在服务端不存在），
 *   由 `KnowledgeGraph3D.tsx` 以 `ssr: false` 动态引入。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ForceGraph3D, { type ForceGraphMethods } from "react-force-graph-3d";
import * as THREE from "three";
import type { KnowledgeEdge, KnowledgeNode } from "@/lib/types";

/** 图谱节点（带度数） */
interface Graph3DNode extends KnowledgeNode {
  degree: number;
}

/** 边的唯一键 */
function edgeKey(edge: KnowledgeEdge, index: number): string {
  return `${edge.source}~${edge.target}~${edge.kind}~${index}`;
}

/** 相机距离档位 */
type Tier = "far" | "mid" | "near";

/** 档位阈值：相机距离 / 图谱半径 */
const TIER_MID = 2.0;
const TIER_NEAR = 1.05;

/** 远景展示的"常见病种"数量（按关联度数取前 N） */
const FAR_DISEASE_COUNT = 12;

/** 远景仍保留的高连接症状（让远景不是一堆孤立的球） */
const FAR_SYMPTOM_MIN_DEGREE = 3;

/** 同时可见的标签上限 */
const MAX_LABELS = 42;

/** 3D 配色（深色画布下的高可读配色） */
const COLORS = {
  bg: "#0b1220",
  disease: "#fb7185",
  symptom: "#2dd4bf",
  scale: "#94a3b8",
  /** 普通连线：深底上必须用亮色，否则几乎看不见 */
  link: "#7c93b0",
  /** 核心症状连线 */
  linkCore: "#2dd4bf",
  label: "#e2e8f0",
};

export interface KnowledgeGraph3DProps {
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  /** 是否把「尚未挂到任何病种」的孤立词条也放进 3D 场景 */
  showIsolated: boolean;
  /** 点击节点回调；传 null 表示点击空白处取消选中 */
  onSelect?: (node: KnowledgeNode | null) => void;
}

export default function KnowledgeGraph3DInner({
  nodes,
  edges,
  showIsolated,
  onSelect,
}: KnowledgeGraph3DProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const labelLayerRef = useRef<HTMLDivElement | null>(null);
  const fgRef = useRef<ForceGraphMethods<any, any> | undefined>(undefined);

  /**
   * 画布尺寸。
   *
   * **必须显式传给 `<ForceGraph3D width height>`**：
   * three-render-objects 的 width/height 默认值是 `window.innerWidth/innerHeight`，
   * 不传就会按整个视口尺寸建画布（1600×1100），把容器撑破、也把投影算错。
   */
  const [size, setSize] = useState({ width: 800, height: 620 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect || rect.width <= 0 || rect.height <= 0) return;
      setSize({
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /** 节点 three 对象 */
  const meshMap = useRef(new Map<string, THREE.Mesh>());
  /** 连线 three 对象 */
  const linkMap = useRef(new Map<string, THREE.Line>());
  /** 待释放的旧 three 对象（被库替换下来的，延迟一帧释放） */
  const retiredRef = useRef<THREE.Object3D[]>([]);
  /** 标签 DOM */
  const labelMap = useRef(new Map<string, HTMLDivElement>());
  /** 是否已完成首次取景 */
  const framedRef = useRef(false);
  /** 引擎是否已停稳（停稳后节点位置才确定，才好取景） */
  const engineStoppedRef = useRef(false);
  /** 当前分档（仅用于诊断输出变化） */
  const lastTierRef = useRef<Tier | null>(null);

  /** 节点度数 */
  const degreeMap = useMemo(() => {
    const map = new Map<string, number>();
    nodes.forEach((node) => map.set(node.id, 0));
    edges.forEach((edge) => {
      map.set(edge.source, (map.get(edge.source) ?? 0) + 1);
      map.set(edge.target, (map.get(edge.target) ?? 0) + 1);
    });
    return map;
  }, [nodes, edges]);

  /** 病种按关联度数排序（远景取"常见疾病"） */
  const commonDiseaseIds = useMemo(() => {
    return nodes
      .filter((node) => node.type === "disease")
      .sort(
        (a, b) =>
          (degreeMap.get(b.id) ?? 0) - (degreeMap.get(a.id) ?? 0),
      )
      .slice(0, FAR_DISEASE_COUNT)
      .map((node) => node.id);
  }, [nodes, degreeMap]);

  /** 传给力导向图的数据 */
  const graphData = useMemo(() => {
    /**
     * **孤立词条（度为 0）默认不参与 3D 布局**。
     *
     * 它们没有任何连线，只受斥力作用，会被推到极远处（实测把图谱半径
     * 从 ~300 撑到 1215），结果主体簇被挤成一小团、看着像"缩了"。
     * 这些词条本身没有结构意义，默认收起，由页面的「无关联词条」开关按需打开。
     */
    const layoutNodes = showIsolated
      ? nodes
      : nodes.filter((node) => (degreeMap.get(node.id) ?? 0) > 0);
    const layoutIds = new Set(layoutNodes.map((n) => n.id));

    const graphNodes: Graph3DNode[] = layoutNodes.map((node) => ({
      ...node,
      degree: degreeMap.get(node.id) ?? 0,
    }));
    const graphLinks = edges
      .filter((edge) => layoutIds.has(edge.source) && layoutIds.has(edge.target))
      .map((edge, index) => ({
        id: edgeKey(edge, index),
        source: edge.source,
        target: edge.target,
        /**
         * 额外存一份**字符串** id：d3-force 初始化时会用节点对象替换
         * `link.source` / `link.target`，之后拿它们去查 id 集合必然落空，
         * 会导致所有连线被判为「端点不可见」而全部隐藏。
         */
        sourceId: edge.source,
        targetId: edge.target,
        kind: edge.kind,
        label: edge.label ?? "",
      }));
    return { nodes: graphNodes, links: graphLinks };
  }, [nodes, edges, degreeMap, showIsolated]);

  /** 文本测宽（用离屏 canvas，保证与 DOM 字体一致） */
  const measureCtx = useMemo(() => {
    if (typeof document === "undefined") return null;
    const canvas = document.createElement("canvas");
    return canvas.getContext("2d");
  }, []);

  /** 创建节点 three 对象 */
  const buildNodeObject = useCallback(
    (node: Graph3DNode) => {
      const radius = 2.2 + Math.sqrt(node.degree) * 0.78;
      const color =
        node.type === "disease"
          ? COLORS.disease
          : node.type === "symptom"
            ? COLORS.symptom
            : COLORS.scale;
      const geometry = new THREE.SphereGeometry(radius, 18, 14);
      const material = new THREE.MeshStandardMaterial({
        color: new THREE.Color(color),
        roughness: 0.42,
        metalness: 0.05,
        emissive: new THREE.Color(color),
        emissiveIntensity: 0.22,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.userData.nodeId = node.id;
      // 旧对象由库在 flush 时替换，延迟一帧再释放，避免同帧渲染到已释放的几何体
      const previous = meshMap.current.get(node.id);
      if (previous) retiredRef.current.push(previous);
      meshMap.current.set(node.id, mesh);
      return mesh;
    },
    [],
  );

  /** 创建连线 three 对象 */
  const buildLinkObject = useCallback(
    (link: { id: string; kind: string }) => {
      const geometry = new THREE.BufferGeometry();
      const material = new THREE.LineBasicMaterial({
        color: new THREE.Color(
          link.kind === "core" ? COLORS.linkCore : COLORS.link,
        ),
        transparent: true,
        opacity: link.kind === "core" ? 0.55 : 0.3,
      });
      const line = new THREE.Line(geometry, material);
      line.userData.linkId = link.id;
      const previous = linkMap.current.get(link.id);
      if (previous) retiredRef.current.push(previous);
      linkMap.current.set(link.id, line);
      return line;
    },
    [],
  );

  /** 创建标签 DOM（不参与 React 渲染，直接改样式） */
  const buildLabel = useCallback(
    (node: Graph3DNode) => {
      const layer = labelLayerRef.current;
      if (!layer) return;
      const el = document.createElement("div");
      el.textContent = node.label;
      el.style.position = "absolute";
      el.style.left = "0";
      el.style.top = "0";
      el.style.whiteSpace = "nowrap";
      el.style.fontSize = "12px";
      el.style.lineHeight = "18px";
      el.style.padding = "1px 6px";
      el.style.borderRadius = "4px";
      el.style.color = COLORS.label;
      el.style.background =
        node.type === "disease"
          ? "rgba(251, 113, 133, 0.22)"
          : node.type === "scale"
            ? "rgba(148, 163, 184, 0.20)"
            : "rgba(13, 148, 136, 0.18)";
      el.style.border = `1px solid ${
        node.type === "disease"
          ? "rgba(251, 113, 133, 0.55)"
          : node.type === "scale"
            ? "rgba(148, 163, 184, 0.45)"
            : "rgba(45, 212, 191, 0.42)"
      }`;
      el.style.fontWeight = node.type === "disease" ? "600" : "400";
      el.style.pointerEvents = "none";
      el.style.willChange = "transform";
      el.style.display = "none";
      layer.appendChild(el);
      labelMap.current.set(node.id, el);
    },
    [],
  );

  /**
   * 节点/连线访问器必须**保持引用稳定**。
   *
   * three-forcegraph 靠「属性是否变化」决定要不要重建场景对象，
   * 而连线几何体的顶点**只在布局 tick 时填充**（引擎停止后不再更新）。
   * 如果访问器写成内联箭头函数，每次 React 渲染身份都会变 → 库反复重建
   * 场景对象 → 引擎已停止时新建的连线几何体永远是空的 → **连线一条都不显示**。
   */
  const nodeAccessor = useCallback(
    (node: Graph3DNode) => buildNodeObject(node),
    [buildNodeObject],
  );
  const linkAccessor = useCallback(
    (link: { id: string; kind: string }) => buildLinkObject(link),
    [buildLinkObject],
  );

  /**
   * 数据变化时的清理。
   *
   * 注意**不能在这里清空 meshMap / linkMap**：three-forcegraph 是在它自己的
   * 渲染帧里 flush 场景对象（调用 `nodeThreeObject` / `linkThreeObject`），
   * 而本 effect 在 React 提交后**先于**那个 flush 执行——一旦清空，
   * 之后 flush 出来的对象就找不到引用，导致「节点存在但没有任何标签/分级显隐」。
   *
   * 这里只做两件事：释放已经从数据里移除的对象、重建标签层。
   */
  useEffect(() => {
    const layer = labelLayerRef.current;
    if (!layer) return;

    const nodeIds = new Set(graphData.nodes.map((n) => n.id));
    const linkIds = new Set(graphData.links.map((l) => l.id));
    meshMap.current.forEach((mesh, id) => {
      if (nodeIds.has(id)) return;
      retiredRef.current.push(mesh);
      meshMap.current.delete(id);
    });
    linkMap.current.forEach((line, id) => {
      if (linkIds.has(id)) return;
      retiredRef.current.push(line);
      linkMap.current.delete(id);
    });

    // 标签是 DOM，独立于 three 场景，这里重建
    labelMap.current.clear();
    layer.innerHTML = "";
    graphData.nodes.forEach((node) => buildLabel(node));
  }, [graphData, buildLabel]);

  /**
   * 稳健的图谱中心与半径。
   *
   * **不能用 `getGraphBbox()` 的包围盒半径**：3D 力导向总会有少数节点被甩到
   * 很远处，包围盒被这些离群点撑大，相机一退就退到极远，主簇缩成一小团。
   * 这里改用「节点位置到质心的距离」的 80 分位数作为半径，抗离群点。
   */
  const computeMetrics = useCallback(() => {
    const points: THREE.Vector3[] = [];
    const v = new THREE.Vector3();
    meshMap.current.forEach((mesh) => {
      mesh.getWorldPosition(v);
      points.push(v.clone());
    });
    if (!points.length) return null;
    const center = new THREE.Vector3();
    points.forEach((p) => center.add(p));
    center.divideScalar(points.length);
    const distances = points
      .map((p) => p.distanceTo(center))
      .sort((a, b) => a - b);
    const radius = Math.max(
      10,
      distances[
        Math.min(distances.length - 1, Math.floor(distances.length * 0.8))
      ],
    );
    return { center, radius };
  }, []);

  /**
   * 布局与交互调参（必须在实例就绪后调用，且这些是**实例方法**，只能走 ref）。
   *
   * - 3D 的多体力斥按 1/r² 衰减，比 2D 需要更大的强度，否则节点会抱团；
   * - 连线距离拉大，避免线条交叉成"面条"；
   * - 轨道控制器开阻尼，缩放更顺滑。
   */
  useEffect(() => {
    let raf = 0;
    let tries = 0;
    const setup = () => {
      const fg = fgRef.current;
      if (!fg) {
        if (tries < 120) {
          tries += 1;
          raf = requestAnimationFrame(setup);
        }
        return;
      }
      /**
       * 3D 力参数标定（实测得出）：
       * - 斥力太大会把图谱撑爆（实测 charge=-95 时半径涨到 1215 单位，
       *   节点在固定画布里只剩几个像素，看着像"缩成一小团"）；
       * - d3 的连线弹簧默认强度是 1/min(度数) ≈ 0.09，太弱，拉不住节点；
       * - 因此这里用「中等斥力 + 明确连线距离 + 加大连线强度」，
       *   让图谱稳定在半径 200~300 单位，节点在画布里清晰可辨。
       */
      fg.d3Force("charge")?.strength?.(-45);
      fg.d3Force("link")?.distance?.(46);
      fg.d3Force("link")?.strength?.(0.55);
      fg.d3ReheatSimulation();

      const controls = fg.controls() as unknown as {
        enableDamping?: boolean;
        dampingFactor?: number;
        rotateSpeed?: number;
        zoomSpeed?: number;
        minDistance?: number;
        maxDistance?: number;
      } | null;
      if (controls) {
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        controls.rotateSpeed = 0.85;
        controls.zoomSpeed = 0.9;
      }
    };
    raf = requestAnimationFrame(setup);
    return () => cancelAnimationFrame(raf);
  }, []);

  /**
   * 每帧更新：分级显隐 + 标签贪心避让。
   *
   * 不走 React 状态，避免 60fps 重渲染。
   */
  useEffect(() => {
    let raf = 0;
    const tmpVec = new THREE.Vector3();
    const ndc = new THREE.Vector3();
    /** 本帧已占用的标签矩形（屏幕坐标） */
    const placed: { x: number; y: number; w: number; h: number }[] = [];

    const updateFrame = (
      fg: ForceGraphMethods<any, any>,
      container: HTMLDivElement,
    ) => {
      // 释放上一帧被替换下来的 three 对象
      if (retiredRef.current.length) {
        retiredRef.current.forEach((obj) => {
          const mesh = obj as THREE.Mesh;
          mesh.geometry?.dispose?.();
          const material = mesh.material as THREE.Material | undefined;
          material?.dispose?.();
        });
        retiredRef.current.length = 0;
      }

      const camera = fg.camera();
      const width = container.clientWidth;
      const height = container.clientHeight;
      if (!width || !height) return;

      // ---- 计算图谱中心与半径（用于档位判定，稳健值抗离群点）----
      const metrics = computeMetrics();
      if (!metrics) return;
      const { center, radius } = metrics;

      // ---- 首次取景：等引擎停稳、节点对象就绪后再做，且只做一次 ----
      if (!framedRef.current && engineStoppedRef.current) {
        framedRef.current = true;
        fg.cameraPosition(
          { x: center.x, y: center.y, z: center.z + radius * 2.0 },
          { x: center.x, y: center.y, z: center.z },
          700,
        );
        console.log(
          "[知识图谱3D] 首次取景",
          JSON.stringify({
            radius: Math.round(radius),
            camera: [
              Math.round(camera.position.x),
              Math.round(camera.position.y),
              Math.round(camera.position.z),
            ],
          }),
        );
      }

      const camDist = camera.position.distanceTo(center);
      const t = camDist / radius;
      const tier: Tier =
        t > TIER_MID ? "far" : t > TIER_NEAR ? "mid" : "near";
      if (lastTierRef.current !== tier) {
        lastTierRef.current = tier;
        console.log(
          "[知识图谱3D] 分级",
          JSON.stringify({
            tier,
            t: Number(t.toFixed(2)),
            camDist: Math.round(camDist),
            radius: Math.round(radius),
          }),
        );
      }

      // ---- 节点分级显隐 ----
      const visibleNode = new Set<string>();
      graphData.nodes.forEach((node) => {
        let visible = true;
        if (tier === "far") {
          // 远景：以常见病种为骨架，只保留高连接症状撑起结构
          visible =
            commonDiseaseIds.includes(node.id) ||
            (node.type === "symptom" && node.degree >= FAR_SYMPTOM_MIN_DEGREE);
        } else if (tier === "mid") {
          visible = node.type !== "symptom" || node.degree >= 2;
        }
        const mesh = meshMap.current.get(node.id);
        if (mesh) mesh.visible = visible;
        if (visible) visibleNode.add(node.id);
      });

      // ---- 连线显隐：两端都可见才显示 ----
      graphData.links.forEach((link) => {
        const line = linkMap.current.get(link.id);
        if (!line) return;
        // 注意用 sourceId/targetId（字符串），不能用 link.source/target
        // ——d3-force 已把它们替换成节点对象
        const src = link.sourceId;
        const tgt = link.targetId;
        let visible = visibleNode.has(src) && visibleNode.has(tgt);
        if (visible && tier === "mid") {
          visible = link.kind === "core" || link.kind === "focus";
        }
        line.visible = visible;
      });

      // ---- 标签：按距相机由近到远贪心占位，重叠则隐藏 ----
      placed.length = 0;
      const candidates: { id: string; dist: number; x: number; y: number }[] = [];

      graphData.nodes.forEach((node) => {
        const mesh = meshMap.current.get(node.id);
        const el = labelMap.current.get(node.id);
        if (!mesh || !el) return;
        if (!visibleNode.has(node.id)) {
          el.style.display = "none";
          return;
        }
        // 档位决定「这一档允许显示哪些类型的标签」
        const typeAllowed =
          tier === "far"
            ? node.type === "disease"
            : tier === "mid"
              ? node.type !== "symptom"
              : true;
        if (!typeAllowed) {
          el.style.display = "none";
          return;
        }
        mesh.getWorldPosition(tmpVec);
        const dist = camera.position.distanceTo(tmpVec);
        ndc.copy(tmpVec).project(camera);
        // 相机背后的节点不显示
        if (ndc.z > 1) {
          el.style.display = "none";
          return;
        }
        const px = (ndc.x * 0.5 + 0.5) * width;
        const py = (-ndc.y * 0.5 + 0.5) * height;
        if (px < -80 || px > width + 80 || py < -40 || py > height + 40) {
          el.style.display = "none";
          return;
        }
        candidates.push({ id: node.id, dist, x: px, y: py });
      });

      candidates.sort((a, b) => a.dist - b.dist);

      let shown = 0;
      candidates.forEach((item) => {
        const el = labelMap.current.get(item.id);
        if (!el) return;
        if (shown >= MAX_LABELS) {
          el.style.display = "none";
          return;
        }
        const text = el.textContent ?? "";
        const w = measureCtx
          ? measureCtx.measureText(text).width + 14
          : text.length * 12;
        const h = 20;
        const box = { x: item.x - w / 2, y: item.y - h / 2, w, h };
        const overlap = placed.some(
          (p) =>
            box.x < p.x + p.w + 3 &&
            box.x + box.w + 3 > p.x &&
            box.y < p.y + p.h + 3 &&
            box.y + box.h + 3 > p.y,
        );
        if (overlap) {
          el.style.display = "none";
          return;
        }
        placed.push(box);
        el.style.display = "block";
        el.style.transform = `translate3d(${Math.round(item.x)}px, ${Math.round(
          item.y,
        )}px, 0) translate(-50%, -50%)`;
        shown += 1;
      });
    };

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const fg = fgRef.current;
      const container = containerRef.current;
      if (!fg || !container) return;

      try {
        updateFrame(fg, container);
      } catch (err) {
        // 渲染循环里的异常不能静默吞掉，否则会表现为"画面不动、没有标签"
        console.error("[知识图谱3D] 每帧更新失败：", err);
      }
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [graphData, commonDiseaseIds, measureCtx, computeMetrics]);

  return (
    <div
      ref={containerRef}
      className="relative h-[620px] w-full overflow-hidden rounded-clin"
      style={{ background: COLORS.bg }}
    >
      <ForceGraph3D
        ref={fgRef}
        graphData={graphData}
        width={size.width}
        height={size.height}
        backgroundColor={COLORS.bg}
        controlType="orbit"
        showNavInfo={false}
        nodeThreeObject={nodeAccessor}
        linkThreeObject={linkAccessor}
        linkOpacity={0.5}
        linkDirectionalParticles={0}
        d3AlphaDecay={0.025}
        d3VelocityDecay={0.32}
        cooldownTicks={240}
        warmupTicks={40}
        onNodeClick={(node: any) => onSelect?.(node)}
        onBackgroundClick={() => onSelect?.(null)}
        onEngineStop={() => {
          /**
           * **只在第一次布局稳定时取景一次**。
           *
           * 这里只标记「引擎已停稳」，真正的取景放到渲染循环里做——
           * 因为 `onEngineStop` 触发时 three 的节点对象可能还没建好，
           * 此时算不出中心与半径（曾经因此取景被跳过，相机停在默认 z=1000，
           * 整个图缩成一小团）。
           *
           * 取景只做一次，之后视角完全交给用户，不会再有自动变化。
           */
          engineStoppedRef.current = true;
        }}
      />
      {/* 标签覆盖层 */}
      <div
        ref={labelLayerRef}
        className="pointer-events-none absolute inset-0 overflow-hidden"
      />
    </div>
  );
}
