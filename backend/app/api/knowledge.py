"""医护知识库可视化接口（**线 B：结论与运营**）。

把「疾病库 + 症状词表 + 量表题库」的关系暴露成可交互图谱：

- 节点：`disease`（病种）、`symptom`（症状词条）、`scale`（量表）
- 边：疾病→症状（`core` 核心 / `secondary` 次要）、疾病→量表（`focus` 关注项，含具体题号）、
  症状→症状（`synonym` 同义 / `differential` 鉴别关联）

数据只读自 `docs/structured/**`（线 B 拥有的资产）与题库元信息，**不产生新的医学结论**。
"""

from __future__ import annotations

from fastapi import Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.api import new_router
from app.core.deps import get_current_user, require_staff
from app.db.base import get_db
from app.db.models import User
from app.services.disease_library import (
    load_disease_file,
    load_symptoms,
    symptom_term,
)

router = new_router()


def _scale_index() -> dict[str, dict]:
    """量表元信息（题号 → 题目文本），题库属线 A，这里只读。"""
    from app.services.scales_store import load_scale_files

    index: dict[str, dict] = {}
    for code, payload in load_scale_files().items():
        questions = {
            question.get("code", ""): question.get("text", "")
            for section in payload.get("sections", [])
            for question in section.get("questions", [])
        }
        index[code] = {
            "code": code,
            "name": payload.get("name", code),
            "dimension": payload.get("dimension", ""),
            "method": payload.get("method", ""),
            "item_count": len(questions),
            "questions": questions,
        }
    return index


@router.get("/knowledge/graph")
def knowledge_graph(
    node_type: str = Query("", description="按类型过滤：disease / symptom / scale，留空为全部"),
    keyword: str = Query("", description="按名称过滤节点"),
    user: User = Depends(require_staff),
    db: Session = Depends(get_db),
):
    """知识库关系图谱（节点 + 边）。"""
    diseases = load_disease_file().get("diseases", [])
    symptoms = load_symptoms()
    scales = _scale_index()

    nodes: list[dict] = []
    edges: list[dict] = []

    if node_type in {"", "disease"}:
        for disease in diseases:
            code = disease.get("code", "")
            nodes.append(
                {
                    "id": f"disease:{code}",
                    "type": "disease",
                    "label": disease.get("name", code),
                    "group": disease.get("system", ""),
                    "risk": disease.get("risk_level", "observe"),
                    "meta": {
                        "aliases": disease.get("aliases", []),
                        "review_status": disease.get("review_status", "draft_pending_medical_review"),
                        "atypical": (disease.get("atypical_presentations") or [])[:2],
                        "advice": (disease.get("advice") or {}).get("text", ""),
                    },
                }
            )

    if node_type in {"", "symptom"}:
        for code, item in symptoms.items():
            nodes.append(
                {
                    "id": f"symptom:{code}",
                    "type": "symptom",
                    "label": item.get("term", code),
                    "group": item.get("category", ""),
                    "meta": {
                        "synonyms": item.get("synonyms", [])[:4],
                        "probe": item.get("probe", ""),
                    },
                }
            )

    if node_type in {"", "scale"}:
        for code, item in scales.items():
            nodes.append(
                {
                    "id": f"scale:{code}",
                    "type": "scale",
                    "label": item.get("name", code),
                    "group": item.get("dimension", ""),
                    "meta": {
                        "method": item.get("method", ""),
                        "item_count": item.get("item_count", 0),
                    },
                }
            )

    for disease in diseases:
        code = disease.get("code", "")
        for symptom in disease.get("symptoms", []) or []:
            symptom_code = symptom.get("code", "")
            if symptom_code not in symptoms:
                continue
            edges.append(
                {
                    "source": f"disease:{code}",
                    "target": f"symptom:{symptom_code}",
                    "kind": symptom.get("weight", "secondary"),
                    "label": "核心症状" if symptom.get("weight") == "core" else "次要症状",
                }
            )
        for link in disease.get("scale_links", []) or []:
            scale_code = link.get("scale", "")
            if scale_code not in scales:
                continue
            edges.append(
                {
                    "source": f"disease:{code}",
                    "target": f"scale:{scale_code}",
                    "kind": "focus",
                    "label": link.get("note", "关注项"),
                    "item": link.get("item", ""),
                    "item_text": scales[scale_code]["questions"].get(link.get("item", ""), ""),
                }
            )

    if keyword:
        key = keyword.strip().lower()
        nodes = [
            node
            for node in nodes
            if key in str(node.get("label", "")).lower() or key in str(node.get("id", "")).lower()
        ]
        keep = {node["id"] for node in nodes}
        edges = [edge for edge in edges if edge["source"] in keep and edge["target"] in keep]

    # 症状 → 症状：同义词归并（词表里的 synonyms 互指），供「同症多病」提示
    synonym_index: dict[str, list[str]] = {}
    for code, item in symptoms.items():
        for synonym in item.get("synonyms", []) or []:
            synonym_index.setdefault(synonym, []).append(code)
    for term, codes in synonym_index.items():
        targets = [c for c in codes if c in symptoms]
        if len(targets) < 2:
            continue
        for index, left in enumerate(targets):
            for right in targets[index + 1 :]:
                edges.append(
                    {
                        "source": f"symptom:{left}",
                        "target": f"symptom:{right}",
                        "kind": "synonym",
                        "label": f"同义：{term}",
                    }
                )

    counts = {"disease": 0, "symptom": 0, "scale": 0}
    for node in nodes:
        counts[node["type"]] = counts.get(node["type"], 0) + 1

    return {
        "nodes": nodes,
        "edges": edges,
        "stats": {
            "nodes": len(nodes),
            "edges": len(edges),
            "by_type": counts,
            "edge_kinds": {
                "core": sum(1 for edge in edges if edge["kind"] == "core"),
                "secondary": sum(1 for edge in edges if edge["kind"] == "secondary"),
                "focus": sum(1 for edge in edges if edge["kind"] == "focus"),
                "synonym": sum(1 for edge in edges if edge["kind"] == "synonym"),
            },
        },
        "notice": "图谱内容来自待医学评审的疾病库与词表草稿，仅供医护参考，不构成诊断。",
    }


@router.get("/knowledge/symptoms/{code}")
def symptom_detail(
    code: str,
    user: User = Depends(require_staff),
    db: Session = Depends(get_db),
):
    """单个症状的详情：关联病种、鉴别问法、可加测的量表。"""
    symptoms = load_symptoms()
    item = symptoms.get(code)
    if item is None:
        raise HTTPException(status_code=404, detail="症状词条不存在")

    related: list[dict] = []
    scales: dict[str, dict] = {}
    for disease in load_disease_file().get("diseases", []):
        hit = next(
            (s for s in disease.get("symptoms", []) or [] if s.get("code") == code),
            None,
        )
        if hit is None:
            continue
        related.append(
            {
                "code": disease.get("code"),
                "name": disease.get("name"),
                "weight": hit.get("weight"),
                "risk_level": disease.get("risk_level"),
                "system": disease.get("system"),
                "advice": (disease.get("advice") or {}).get("text", ""),
                "atypical": (disease.get("atypical_presentations") or [])[:2],
            }
        )
        for link in disease.get("scale_links", []) or []:
            scales.setdefault(
                link.get("scale", ""),
                {"scale": link.get("scale", ""), "note": link.get("note", ""), "item": link.get("item", "")},
            )

    return {
        "code": code,
        "term": item.get("term", code),
        "category": item.get("category", ""),
        "synonyms": item.get("synonyms", []),
        "probe": item.get("probe", ""),
        "related_diseases": sorted(related, key=lambda row: (row["weight"] != "core", row["code"] or "")),
        "related_scales": list(scales.values()),
        "disease_count": len(related),
        "notice": "词条与关联病种来自待医学评审的草稿，仅供医护参考。",
    }


@router.get("/knowledge/overview")
def knowledge_overview(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """知识库概览：规模与覆盖度统计。"""
    from app.services.disease_library import list_diseases

    diseases = list_diseases(db)
    symptoms = load_symptoms()
    scales = _scale_index()

    with_items = sum(1 for item in scales.values() if item["item_count"] > 0)
    core_total = 0
    for disease in diseases:
        payload = disease.get("payload") or {}
        core_total += sum(1 for s in payload.get("symptoms", []) if s.get("weight") == "core")

    return {
        "diseases": len(diseases),
        "symptoms": len(symptoms),
        "scales": len(scales),
        "scales_with_items": with_items,
        "core_symptom_links": core_total,
        "symptoms_with_probe": sum(1 for item in symptoms.values() if item.get("probe")),
        "review_status": "draft_pending_medical_review",
    }
