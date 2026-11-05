"use client";

import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { KnowledgeEdge, KnowledgeNode } from "@/lib/types";
import { buildMatrix } from "./graphTokens";

/**
 * 症状 × 疾病矩阵热力图（**降级视图**）。
 *
 * 当 canvas 不可用、或用户主动切换到「矩阵视图」时启用，
 * 保证在 WebGL/canvas 受限的环境下功能仍然可用。
 *
 * 矩阵本身用 CSS grid 精确渲染（行列对齐、热力深浅按权重），
 * 右侧用 recharts 给出「核心症状数 Top 病种」的条形排行作为量化补充。
 */

/** 热力色阶：0=无关联，1=次要症状，2=核心症状 */
const HEAT_CLASS: Record<number, string> = {
  0: "bg-clin-bg",
  1: "bg-clin-accent-soft",
  2: "bg-clin-accent",
};

export function KnowledgeMatrix({
  nodes,
  edges,
  onSelectDisease,
}: {
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  /** 点击病种列头时回调 */
  onSelectDisease?: (nodeId: string) => void;
}) {
  const matrix = useMemo(() => buildMatrix(nodes, edges), [nodes, edges]);

  /** 症状 × 疾病 的权重索引 */
  const cellIndex = useMemo(() => {
    const index = new Map<string, number>();
    matrix.cells.forEach((cell) => {
      index.set(`${cell.symptom}::${cell.disease}`, cell.weight);
    });
    return index;
  }, [matrix]);

  /** 各病种的核心症状数（用于条形排行） */
  const ranking = useMemo(() => {
    const counts = new Map<string, { label: string; core: number; total: number }>();
    matrix.cells.forEach((cell) => {
      const entry = counts.get(cell.disease) ?? {
        label: cell.diseaseLabel,
        core: 0,
        total: 0,
      };
      entry.total += 1;
      if (cell.weight === 2) entry.core += 1;
      counts.set(cell.disease, entry);
    });
    return Array.from(counts.entries())
      .map(([id, value]) => ({ id, ...value }))
      .sort((a, b) => b.core - a.core || b.total - a.total)
      .slice(0, 12);
  }, [matrix]);

  if (matrix.diseases.length === 0 || matrix.symptoms.length === 0) {
    return (
      <p className="py-8 text-center text-clin-sm text-clin-fg-subtle">
        当前筛选条件下没有可展示的症状—疾病关联。
      </p>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_280px]">
      {/* ------------------------------ 矩阵 ------------------------------ */}
      <div className="min-w-0">
        <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-clin-xs text-clin-fg-muted">
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="h-2.5 w-2.5 rounded-sm bg-clin-accent" />
            核心症状
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="h-2.5 w-2.5 rounded-sm bg-clin-accent-soft" />
            次要症状
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="h-2.5 w-2.5 rounded-sm border border-clin-border bg-clin-bg" />
            无关联
          </span>
          <span className="text-clin-fg-subtle">
            {matrix.symptoms.length} 个症状 × {matrix.diseases.length} 个病种
          </span>
        </div>

        <div className="max-h-[560px] overflow-auto rounded-clin border border-clin-border">
          <table className="w-full border-collapse text-left">
            <thead className="sticky top-0 z-10 bg-clin-muted">
              <tr>
                <th className="sticky left-0 z-10 bg-clin-muted px-2 py-1.5 text-clin-xs font-medium text-clin-fg-muted">
                  症状 \ 病种
                </th>
                {matrix.diseases.map((disease) => (
                  <th
                    key={disease.id}
                    className="px-1 py-1.5 text-clin-xs font-normal text-clin-fg-muted"
                    title={disease.label}
                  >
                    <button
                      type="button"
                      className="max-w-[72px] truncate align-bottom hover:text-clin-accent hover:underline"
                      onClick={() => onSelectDisease?.(disease.id)}
                    >
                      {disease.label}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {matrix.symptoms.map((symptom) => (
                <tr key={symptom.id} className="border-t border-clin-border">
                  <th className="sticky left-0 z-10 max-w-[140px] truncate bg-clin-surface px-2 py-1 text-clin-xs font-normal text-clin-fg-muted">
                    {symptom.label}
                  </th>
                  {matrix.diseases.map((disease) => {
                    const weight = cellIndex.get(`${symptom.id}::${disease.id}`) ?? 0;
                    return (
                      <td
                        key={disease.id}
                        className={`px-1 py-1 text-center ${HEAT_CLASS[weight]}`}
                        title={`${symptom.label} × ${disease.label}${
                          weight === 2 ? "：核心症状" : weight === 1 ? "：次要症状" : "：无关联"
                        }`}
                      >
                        <span
                          className={
                            weight === 2
                              ? "text-[10px] font-medium text-white"
                              : "text-[10px] text-clin-fg-subtle"
                          }
                        >
                          {weight === 0 ? "" : weight === 2 ? "●" : "○"}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ------------------------------ 条形排行 ------------------------------ */}
      <div>
        <h4 className="mb-1 text-clin-sm font-medium text-clin-fg">
          核心症状数 Top 病种
        </h4>
        <p className="mb-2 text-clin-xs text-clin-fg-muted">
          核心症状越多，说明该病种的判读线索越充分。
        </p>
        <div className="h-[320px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={ranking}
              layout="vertical"
              margin={{ top: 0, right: 8, bottom: 0, left: 0 }}
            >
              <CartesianGrid horizontal={false} stroke="var(--c-border)" />
              <XAxis
                type="number"
                stroke="var(--c-fg-muted)"
                fontSize={12}
                tickLine={false}
                axisLine={false}
                allowDecimals={false}
              />
              <YAxis
                type="category"
                dataKey="label"
                stroke="var(--c-fg-muted)"
                fontSize={12}
                tickLine={false}
                axisLine={false}
                width={92}
              />
              <Tooltip
                contentStyle={{
                  fontSize: 12,
                  borderRadius: 6,
                  border: "1px solid var(--c-border)",
                  boxShadow: "none",
                }}
              />
              <Bar
                dataKey="core"
                name="核心症状数"
                fill="var(--c-accent)"
                radius={[0, 2, 2, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
