"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { LayoutGrid, Network, RefreshCw, Search, Box } from "lucide-react";
import { getKnowledgeGraph, getKnowledgeOverview } from "@/lib/api";
import type {
  KnowledgeGraph,
  KnowledgeNode,
  KnowledgeOverview,
} from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import {
  ClinEmpty,
  ClinError,
  ClinLoading,
  ClinPageHeader,
  ClinSection,
} from "@/app/staff/_components/clinical";
import { KnowledgeGraphCytoscape } from "@/components/knowledge/KnowledgeGraphCytoscape";
import { KnowledgeGraph3D } from "@/components/knowledge/KnowledgeGraph3D";
import { KnowledgeMatrix } from "@/components/knowledge/KnowledgeMatrix";
import { KnowledgeDetail } from "@/components/knowledge/KnowledgeDetail";
import {
  NODE_TYPE_LABEL,
  RISK_LABEL,
  filterGraph,
  graphSummary,
  matchesKeyword,
} from "@/components/knowledge/graphTokens";

/** 类型筛选项 */
const TYPE_FILTERS = [
  { value: "disease", label: "疾病" },
  { value: "symptom", label: "症状" },
  { value: "scale", label: "量表" },
];

/** 风险等级筛选项 */
const RISK_FILTERS = [
  { value: "immediate", label: RISK_LABEL.immediate },
  { value: "urgent", label: RISK_LABEL.urgent },
  { value: "elective", label: RISK_LABEL.elective },
  { value: "observe", label: RISK_LABEL.observe },
];

export default function StaffKnowledgePage() {
  const [graph, setGraph] = useState<KnowledgeGraph | null>(null);
  const [overview, setOverview] = useState<KnowledgeOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  /** 筛选状态 */
  const [types, setTypes] = useState<string[]>([
    "disease",
    "symptom",
    "scale",
  ]);
  const [risks, setRisks] = useState<string[]>([]);
  const [keyword, setKeyword] = useState("");
  /** 已提交到后端的关键词（搜索时用 keyword 参数走后端） */
  const [submittedKeyword, setSubmittedKeyword] = useState("");

  /** 视图模式：3D 图谱 / 平面图谱 / 矩阵 */
  const [view, setView] = useState<"3d" | "graph" | "matrix">("3d");
  /** 是否展示「尚未挂到任何病种」的孤立词条（2D / 3D 共用） */
  const [showIsolated, setShowIsolated] = useState(false);
  /** 选中节点 */
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      // 搜索走后端 keyword 参数；其余筛选在前端做，便于即时反馈
      const payload = await getKnowledgeGraph(
        submittedKeyword ? { keyword: submittedKeyword } : undefined,
      );
      setGraph(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : "暂时无法获取知识库图谱。");
    } finally {
      setLoading(false);
    }
  }, [submittedKeyword]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    getKnowledgeOverview()
      .then(setOverview)
      .catch(() => setOverview(null));
  }, []);

  const allNodes = useMemo(() => graph?.nodes ?? [], [graph]);
  const allEdges = useMemo(() => graph?.edges ?? [], [graph]);

  /** 全图节点表（供详情面板查名） */
  const nodeMap = useMemo(() => {
    const map = new Map<string, KnowledgeNode>();
    allNodes.forEach((node) => map.set(node.id, node));
    return map;
  }, [allNodes]);

  /** 前端筛选（类型 + 风险） */
  const visible = useMemo(
    () => filterGraph(allNodes, allEdges, { types, risks }),
    [allNodes, allEdges, types, risks],
  );

  /** 关键词二次过滤（后端已过滤，这里只做一次轻量兜底） */
  const finalNodes = useMemo(
    () => visible.nodes.filter((node) => matchesKeyword(node, submittedKeyword)),
    [visible.nodes, submittedKeyword],
  );
  const finalIds = useMemo(
    () => new Set(finalNodes.map((node) => node.id)),
    [finalNodes],
  );
  const finalEdges = useMemo(
    () => visible.edges.filter((edge) => finalIds.has(edge.source) && finalIds.has(edge.target)),
    [visible.edges, finalIds],
  );

  const summary = useMemo(
    () => graphSummary(finalNodes, finalEdges),
    [finalNodes, finalEdges],
  );

  const selectedNode = selectedId ? nodeMap.get(selectedId) ?? null : null;

  /** 与选中节点直接相连的节点 id */
  const relatedNodeIds = useMemo(() => {
    if (!selectedId) return [];
    const ids: string[] = [];
    finalEdges.forEach((edge) => {
      if (edge.source === selectedId && !ids.includes(edge.target)) {
        ids.push(edge.target);
      }
      if (edge.target === selectedId && !ids.includes(edge.source)) {
        ids.push(edge.source);
      }
    });
    return ids;
  }, [finalEdges, selectedId]);

  const toggleType = (value: string) => {
    setTypes((prev) =>
      prev.includes(value)
        ? prev.filter((item) => item !== value)
        : [...prev, value],
    );
  };

  const toggleRisk = (value: string) => {
    setRisks((prev) =>
      prev.includes(value)
        ? prev.filter((item) => item !== value)
        : [...prev, value],
    );
  };

  const handleSearch = () => {
    setSubmittedKeyword(keyword.trim());
  };

  return (
    <div>
      <ClinPageHeader
        title="知识库可视化"
        description="把疾病库、症状词表与量表题库的关系暴露成可交互图谱，支持按类型与风险过滤、关键词定位，点击节点查看详情。"
        actions={
          <>
            <Button
              variant={view === "3d" ? "default" : "outline"}
              size="sm"
              onClick={() => setView("3d")}
            >
              <Box className="h-3.5 w-3.5" aria-hidden="true" />
              3D 图谱
            </Button>
            <Button
              variant={view === "graph" ? "default" : "outline"}
              size="sm"
              onClick={() => setView("graph")}
            >
              <Network className="h-3.5 w-3.5" aria-hidden="true" />
              平面图谱
            </Button>
            <Button
              variant={view === "matrix" ? "default" : "outline"}
              size="sm"
              onClick={() => setView("matrix")}
            >
              <LayoutGrid className="h-3.5 w-3.5" aria-hidden="true" />
              矩阵视图
            </Button>
          </>
        }
      />

      {/* ------------------------------ 规模概览 ------------------------------ */}
      <div className="mb-6 grid grid-cols-2 gap-px overflow-hidden rounded-clin border border-clin-border bg-clin-border md:grid-cols-4">
        <div className="bg-clin-surface px-4 py-3">
          <p className="text-clin-xs text-clin-fg-muted">节点</p>
          <p className="mt-1 text-clin-lg font-semibold tabular-nums text-clin-fg">
            {summary.nodes}
          </p>
        </div>
        <div className="bg-clin-surface px-4 py-3">
          <p className="text-clin-xs text-clin-fg-muted">关系</p>
          <p className="mt-1 text-clin-lg font-semibold tabular-nums text-clin-fg">
            {summary.edges}
          </p>
        </div>
        <div className="bg-clin-surface px-4 py-3">
          <p className="text-clin-xs text-clin-fg-muted">疾病 / 症状 / 量表</p>
          <p className="mt-1 text-clin-lg font-semibold tabular-nums text-clin-fg">
            {summary.byType.disease} / {summary.byType.symptom} /{" "}
            {summary.byType.scale}
          </p>
        </div>
        <div className="bg-clin-surface px-4 py-3">
          <p className="text-clin-xs text-clin-fg-muted">库规模</p>
          <p className="mt-1 text-clin-lg font-semibold tabular-nums text-clin-fg">
            {overview?.diseases ?? "—"}/{overview?.symptoms ?? "—"}
          </p>
          <p className="mt-0.5 text-clin-xs text-clin-fg-subtle">
            病种 / 症状词条
          </p>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[220px_1fr_320px]">
        {/* ------------------------------ 左侧筛选 ------------------------------ */}
        <aside className="space-y-5">
          <div className="rounded-clin border border-clin-border bg-clin-surface p-3">
            <div className="flex items-center justify-between">
              <h2 className="text-clin-sm font-medium text-clin-fg">筛选</h2>
              <Button
                variant="ghost"
                size="sm"
                aria-label="重置筛选"
                onClick={() => {
                  setTypes(["disease", "symptom", "scale"]);
                  setRisks([]);
                  setKeyword("");
                  setSubmittedKeyword("");
                  setSelectedId(null);
                }}
              >
                重置
              </Button>
            </div>

            <Separator className="my-3" />

            <div>
              <p className="mb-1.5 text-clin-xs font-medium text-clin-fg-muted">
                节点类型
              </p>
              <ul className="space-y-1">
                {TYPE_FILTERS.map((item) => (
                  <li key={item.value} className="flex items-center gap-2">
                    <Switch
                      id={`type-${item.value}`}
                      checked={types.includes(item.value)}
                      onCheckedChange={() => toggleType(item.value)}
                    />
                    <label
                      htmlFor={`type-${item.value}`}
                      className="text-clin-sm text-clin-fg"
                    >
                      {item.label}
                    </label>
                  </li>
                ))}
              </ul>
            </div>

            <Separator className="my-3" />

            <div>
              <p className="mb-1.5 text-clin-xs font-medium text-clin-fg-muted">
                风险等级（仅疾病）
              </p>
              <ul className="space-y-1">
                {RISK_FILTERS.map((item) => (
                  <li key={item.value} className="flex items-center gap-2">
                    <Switch
                      id={`risk-${item.value}`}
                      checked={risks.includes(item.value)}
                      onCheckedChange={() => toggleRisk(item.value)}
                    />
                    <label
                      htmlFor={`risk-${item.value}`}
                      className="text-clin-sm text-clin-fg"
                    >
                      {item.label}
                    </label>
                  </li>
                ))}
              </ul>
            </div>

            <Separator className="my-3" />

            <div>
              <Label htmlFor="knowledge-keyword">关键词</Label>
              <div className="mt-1 flex gap-1.5">
                <Input
                  id="knowledge-keyword"
                  value={keyword}
                  onChange={(event) => setKeyword(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") handleSearch();
                  }}
                  placeholder="病种 / 症状 / 量表"
                />
                <Button variant="outline" size="sm" aria-label="搜索" onClick={handleSearch}>
                  <Search className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              </div>
              <p className="mt-1 text-clin-xs text-clin-fg-subtle">
                搜索走后端 keyword 参数，按名称与编码匹配。
              </p>
            </div>
          </div>

          {overview ? (
            <div className="rounded-clin border border-clin-border bg-clin-surface p-3">
              <h2 className="text-clin-sm font-medium text-clin-fg">覆盖度</h2>
              <dl className="mt-2 space-y-1">
                <CoverRow
                  label="有题目的量表"
                  value={`${overview.scales_with_items ?? 0} / ${overview.scales ?? 0}`}
                />
                <CoverRow
                  label="核心症状关联"
                  value={overview.core_symptom_links ?? 0}
                />
                <CoverRow
                  label="含鉴别问法"
                  value={`${overview.symptoms_with_probe ?? 0} / ${overview.symptoms ?? 0}`}
                />
              </dl>
            </div>
          ) : null}
        </aside>

        {/* ------------------------------ 中部图谱 ------------------------------ */}
        <div className="min-w-0">
          {loading ? (
            <ClinLoading label="正在加载知识库图谱…" />
          ) : error ? (
            <ClinError message={error} onRetry={() => void load()} />
          ) : finalNodes.length === 0 ? (
            <ClinEmpty message="当前筛选条件下没有可展示的节点。" />
          ) : view === "3d" ? (
            <KnowledgeGraph3D
              nodes={finalNodes}
              edges={finalEdges}
              showIsolated={showIsolated}
              onShowIsolatedChange={setShowIsolated}
              onSelect={(node) => setSelectedId(node ? node.id : null)}
            />
          ) : view === "graph" ? (
            <KnowledgeGraphCytoscape
              nodes={finalNodes}
              edges={finalEdges}
              selectedId={selectedId}
              showIsolated={showIsolated}
              onShowIsolatedChange={setShowIsolated}
              onSelect={(node) => setSelectedId(node ? node.id : null)}
            />
          ) : (
            <KnowledgeMatrix
              nodes={finalNodes}
              edges={finalEdges}
              onSelectDisease={(nodeId) => setSelectedId(nodeId)}
            />
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void load()}
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              重新加载
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelectedId(null)}
            >
              取消选中
            </Button>
            <p className="text-clin-xs text-clin-fg-subtle">
              {view === "3d"
                ? "3D 图谱：左键拖拽旋转、滚轮缩放、右键平移；标签按远近贪心避让，缩放时分档展示。"
                : "节点大小按关联度数；点击节点查看详情，拖动节点可调整位置。"}
              {view === "matrix"
                ? "矩阵视图为图谱不可用时的降级路径。"
                : "若画布不可用，可切换到「矩阵视图」。"}
            </p>
          </div>
        </div>

        {/* ------------------------------ 右侧详情 ------------------------------ */}
        <aside>
          <KnowledgeDetail
            node={selectedNode}
            nodeMap={nodeMap}
            relatedNodeIds={relatedNodeIds}
            onSelectNode={(nodeId) => setSelectedId(nodeId)}
          />

          {/* 数据来源与免责提示 */}
          <div className="mt-4 rounded-clin border border-clin-border bg-clin-muted p-3">
            <h3 className="text-clin-xs font-medium text-clin-fg">数据来源与免责</h3>
            <p className="mt-1 text-clin-xs leading-relaxed text-clin-fg-muted">
              {graph?.notice ??
                "图谱内容来自待医学评审的疾病库与词表草稿，仅供医护参考，不构成诊断。"}
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}

/** 覆盖度行 */
function CoverRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-clin-border py-1 last:border-b-0">
      <dt className="text-clin-xs text-clin-fg-muted">{label}</dt>
      <dd className="text-clin-xs font-medium tabular-nums text-clin-fg">{value}</dd>
    </div>
  );
}
