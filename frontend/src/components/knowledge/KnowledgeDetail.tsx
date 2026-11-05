"use client";

import { useEffect, useState } from "react";
import { getSymptomDetail } from "@/lib/api";
import type { KnowledgeNode, SymptomDetail } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ClinLoading } from "@/app/staff/_components/clinical";
import {
  NODE_TYPE_LABEL,
  RISK_LABEL,
  RISK_VARIANT,
} from "./graphTokens";

/**
 * 右侧详情面板：点击图谱节点后展示详情。
 *
 * - 疾病：风险等级、系统、别名、非典型表现、就医建议、关联症状与量表；
 * - 症状：同义词、**鉴别问法**、关联病种列表、关联量表（走后端详情接口）；
 * - 量表：维度、题目数、关注它的病种。
 */
export function KnowledgeDetail({
  node,
  nodeMap,
  relatedNodeIds,
  onSelectNode,
}: {
  /** 当前选中的节点 */
  node: KnowledgeNode | null;
  /** 全图节点表（id → 节点），用于展示关联条目名称 */
  nodeMap: Map<string, KnowledgeNode>;
  /** 与该节点直接相连的节点（用于展示关联症状 / 量表 / 病种） */
  relatedNodeIds: string[];
  /** 点击关联条目时回调 */
  onSelectNode?: (nodeId: string) => void;
}) {
  const [symptomDetail, setSymptomDetail] = useState<SymptomDetail | null>(null);
  const [loading, setLoading] = useState(false);

  const symptomCode =
    node?.type === "symptom" ? node.id.replace(/^symptom:/, "") : null;

  useEffect(() => {
    if (!symptomCode) {
      setSymptomDetail(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void getSymptomDetail(symptomCode)
      .then((detail) => {
        if (!cancelled) setSymptomDetail(detail);
      })
      .catch(() => {
        if (!cancelled) setSymptomDetail(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [symptomCode]);

  if (!node) {
    return (
      <div className="rounded-clin border border-clin-border bg-clin-surface p-4">
        <p className="text-clin-sm font-medium text-clin-fg">详情</p>
        <p className="mt-2 text-clin-xs text-clin-fg-muted">
          在左侧图谱中点击任一节点，此处显示疾病、症状或量表的详细信息。
        </p>
      </div>
    );
  }

  const meta = node.meta ?? {};

  return (
    <div className="rounded-clin border border-clin-border bg-clin-surface">
      <div className="border-b border-clin-border px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="accent">{NODE_TYPE_LABEL[node.type] ?? node.type}</Badge>
          {node.type === "disease" && node.risk ? (
            <Badge variant={RISK_VARIANT[node.risk] ?? "secondary"}>
              {RISK_LABEL[node.risk] ?? node.risk}
            </Badge>
          ) : null}
        </div>
        <h3 className="mt-1.5 text-clin-lg font-semibold text-clin-fg">{node.label}</h3>
        {node.group ? (
          <p className="mt-0.5 text-clin-xs text-clin-fg-muted">{node.group}</p>
        ) : null}
      </div>

      <div className="space-y-4 px-4 py-3">
        {/* ------------------------------ 症状 ------------------------------ */}
        {node.type === "symptom" ? (
          <>
            <DetailBlock title="同义词">
              {loading ? (
                <ClinLoading label="正在加载症状详情…" />
              ) : symptomDetail?.synonyms?.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {symptomDetail.synonyms.map((synonym) => (
                    <Badge key={synonym} variant="secondary">
                      {synonym}
                    </Badge>
                  ))}
                </div>
              ) : (
                <p className="text-clin-xs text-clin-fg-subtle">暂无同义词记录。</p>
              )}
            </DetailBlock>

            <DetailBlock title="鉴别问法">
              {loading ? (
                <p className="text-clin-xs text-clin-fg-subtle">加载中…</p>
              ) : symptomDetail?.probe ? (
                <p className="border-l-2 border-clin-accent pl-3 text-clin-sm text-clin-fg">
                  {symptomDetail.probe}
                </p>
              ) : (
                <p className="text-clin-xs text-clin-fg-subtle">暂无鉴别问法。</p>
              )}
            </DetailBlock>

            <DetailBlock title="关联病种">
              {loading ? (
                <p className="text-clin-xs text-clin-fg-subtle">加载中…</p>
              ) : symptomDetail?.related_diseases?.length ? (
                <ul className="divide-y divide-clin-border">
                  {symptomDetail.related_diseases.map((disease) => (
                    <li key={disease.code} className="py-1.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-clin-sm text-clin-fg">
                          {disease.name ?? disease.code}
                        </span>
                        {disease.weight === "core" ? (
                          <Badge variant="accent">核心</Badge>
                        ) : (
                          <Badge variant="secondary">次要</Badge>
                        )}
                        {disease.risk_level ? (
                          <Badge variant={RISK_VARIANT[disease.risk_level] ?? "secondary"}>
                            {RISK_LABEL[disease.risk_level] ?? disease.risk_level}
                          </Badge>
                        ) : null}
                      </div>
                      {disease.atypical?.length ? (
                        <p className="mt-0.5 text-clin-xs text-clin-fg-muted">
                          非典型表现：{disease.atypical.join("；")}
                        </p>
                      ) : null}
                      {disease.advice ? (
                        <p className="mt-0.5 text-clin-xs text-clin-fg-muted">
                          就医建议：{disease.advice}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-clin-xs text-clin-fg-subtle">暂无关联病种。</p>
              )}
            </DetailBlock>

            <DetailBlock title="可加测量表">
              {loading ? (
                <p className="text-clin-xs text-clin-fg-subtle">加载中…</p>
              ) : symptomDetail?.related_scales?.length ? (
                <ul className="space-y-1">
                  {symptomDetail.related_scales.map((scale) => (
                    <li key={scale.scale} className="text-clin-xs text-clin-fg-muted">
                      <span className="text-clin-sm text-clin-fg">{scale.scale}</span>
                      {scale.note ? ` · ${scale.note}` : ""}
                      {scale.item ? ` · ${scale.item}` : ""}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-clin-xs text-clin-fg-subtle">暂无可加测量表。</p>
              )}
            </DetailBlock>
          </>
        ) : null}

        {/* ------------------------------ 疾病 ------------------------------ */}
        {node.type === "disease" ? (
          <>
            <DetailBlock title="基本信息">
              <dl className="space-y-1 text-clin-sm">
                <Row label="编码" value={node.id.replace(/^disease:/, "")} />
                <Row label="所属系统" value={node.group || "—"} />
                <Row label="风险等级" value={RISK_LABEL[node.risk ?? ""] ?? node.risk ?? "—"} />
                <Row
                  label="别名"
                  value={
                    Array.isArray(meta.aliases) && meta.aliases.length
                      ? meta.aliases.join("、")
                      : "—"
                  }
                />
                <Row
                  label="评审状态"
                  value={
                    typeof meta.review_status === "string"
                      ? meta.review_status
                      : "—"
                  }
                />
              </dl>
            </DetailBlock>

            <DetailBlock title="非典型表现">
              {Array.isArray(meta.atypical) && meta.atypical.length ? (
                <ul className="space-y-1">
                  {meta.atypical.map((item) => (
                    <li key={item} className="text-clin-sm text-clin-fg">
                      · {item}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-clin-xs text-clin-fg-subtle">暂无记录。</p>
              )}
            </DetailBlock>

            <DetailBlock title="就医建议">
              {typeof meta.advice === "string" && meta.advice ? (
                <p className="text-clin-sm text-clin-fg">{meta.advice}</p>
              ) : (
                <p className="text-clin-xs text-clin-fg-subtle">暂无建议。</p>
              )}
            </DetailBlock>

            <DetailBlock title="关联症状与量表">
              <RelatedList
                ids={relatedNodeIds}
                nodeMap={nodeMap}
                onSelectNode={onSelectNode}
                emptyText="暂无关联条目。"
              />
            </DetailBlock>
          </>
        ) : null}

        {/* ------------------------------ 量表 ------------------------------ */}
        {node.type === "scale" ? (
          <>
            <DetailBlock title="基本信息">
              <dl className="space-y-1 text-clin-sm">
                <Row label="编码" value={node.id.replace(/^scale:/, "")} />
                <Row label="维度" value={node.group || "—"} />
                <Row
                  label="采集方法"
                  value={typeof meta.method === "string" ? meta.method : "—"}
                />
                <Row
                  label="题目数"
                  value={
                    typeof meta.item_count === "number" ? String(meta.item_count) : "—"
                  }
                />
              </dl>
            </DetailBlock>

            <DetailBlock title="关注它的病种">
              <RelatedList
                ids={relatedNodeIds}
                nodeMap={nodeMap}
                onSelectNode={onSelectNode}
                emptyText="暂无病种关注该量表。"
              />
            </DetailBlock>
          </>
        ) : null}
      </div>
    </div>
  );
}

/** 详情分组 */
function DetailBlock({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h4 className="mb-1.5 text-clin-xs font-medium text-clin-fg-muted">{title}</h4>
      {children}
    </div>
  );
}

/** 键值行 */
function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-clin-border py-1 last:border-b-0">
      <dt className="shrink-0 text-clin-xs text-clin-fg-muted">{label}</dt>
      <dd className="truncate text-clin-sm text-clin-fg">{value}</dd>
    </div>
  );
}

/** 关联条目列表（按 id 在图谱节点表里查找名称） */
function RelatedList({
  ids,
  nodeMap,
  onSelectNode,
  emptyText,
}: {
  ids: string[];
  /** id → 节点，用于取展示名称 */
  nodeMap: Map<string, KnowledgeNode>;
  onSelectNode?: (nodeId: string) => void;
  emptyText: string;
}) {
  if (ids.length === 0) {
    return <p className="text-clin-xs text-clin-fg-subtle">{emptyText}</p>;
  }

  return (
    <ul className="space-y-1">
      {ids.map((id) => (
        <li key={id}>
          <button
            type="button"
            className="text-left text-clin-sm text-clin-accent hover:underline"
            onClick={() => onSelectNode?.(id)}
          >
            {nodeMap.get(id)?.label ?? id}
          </button>
        </li>
      ))}
    </ul>
  );
}

export { Separator };
