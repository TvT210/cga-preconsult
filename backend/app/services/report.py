"""老年综合评估报告：模板驱动的组装 + Word/PDF 导出。

## 模板驱动

报告结构不再写死在代码里，而是由「报告模板」定义（`report_templates` 表，
基线见 `docs/structured/report-templates/`）：

```jsonc
{
  "cover":    { "title", "subtitle", "fields": [{key,label}], "footer" },
  "toc":      [ {ref, label} ],
  "blocks":   [ {ref, type, title, source, ...} ],
  "signatures": [ {role, name_key} ],
  "header":   {left, right},
  "footer":   {left, right},
  "disclaimer": "…"
}
```

区块类型：`kv`（键值表）、`table`（表格）、`detail`（逐项作答与判读依据）、
`dimension`（维度小结）、`notice`（提示 + 条目）、`match`（疾病匹配与提醒）、
`categories`（分类建议）、`mdt`（多学科意见）、`followup`（随访计划）、
`plain_*`（通俗版专用表述）。

## 渲染管线

`sections`（业务数据） → `build_document()`（文档模型） → `export_docx()` / `export_pdf()`

文档模型是两种格式的共同中间层，避免逻辑重复。PDF 侧带**封面页、目录（真实页码）、
页眉页脚、页码、表格化呈现**；Word 侧同样带封面与目录清单。
"""

from __future__ import annotations

import datetime as dt
import io
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import (
    Alert,
    AssessmentScore,
    AssessmentSession,
    CgaReport,
    Followup,
    MatchRun,
    Patient,
    PeriodicAssessment,
    ReportTemplate,
    ScaleTemplate,
    User,
)

REPORT_DISCLAIMER = (
    "本报告由老年人就医预问诊与老年综合评估系统生成，结果仅供参考，不构成诊断，请结合临床检查由医师判断。"
)

SEVERITY_LABELS = {"none": "无", "low": "轻度", "medium": "中度", "high": "重度"}
ALERT_LEVEL_LABELS = {
    "immediate": "立即就医",
    "urgent": "尽快就医",
    "elective": "择期就诊",
    "observe": "居家观察",
}

DIMENSIONS = ["躯体功能", "精神心理", "社会与环境", "老年综合征"]


def _latest_scores(db: Session, patient_id: int) -> list[AssessmentScore]:
    stmt = (
        select(AssessmentScore)
        .where(AssessmentScore.patient_id == patient_id)
        .order_by(AssessmentScore.created_at.desc())
    )
    scores = db.execute(stmt).scalars().all()
    latest: dict[str, AssessmentScore] = {}
    for score in scores:
        latest.setdefault(score.scale_code, score)
    return [latest[key] for key in sorted(latest)]


def _dimension_summary(scores: list[AssessmentScore], scale_dims: dict[str, str]) -> list[dict]:
    summary: list[dict] = []
    for dimension in DIMENSIONS:
        matched = [s for s in scores if scale_dims.get(s.scale_code) == dimension]
        abnormal = [s for s in matched if s.abnormal]
        summary.append(
            {
                "dimension": dimension,
                "scale_count": len(matched),
                "abnormal_count": len(abnormal),
                "conclusion": (
                    f"共 {len(matched)} 项量表参与小结，{len(abnormal)} 项提示异常。"
                    if matched
                    else "本维度暂无可用结果，待施测。"
                ),
                "abnormal_scales": [
                    {
                        "scale_code": s.scale_code,
                        "scale_name": s.scale_code,
                        "level": s.level,
                        "interpretation": s.interpretation,
                    }
                    for s in abnormal
                ],
            }
        )
    return summary


def _interventions(scores: list[AssessmentScore]) -> list[dict]:
    """由阳性标记推导可执行建议（按主题分组）。"""
    buckets: dict[str, list[str]] = {
        "营养": [],
        "运动": [],
        "用药": [],
        "心理": [],
        "照护": [],
        "环境改造": [],
    }
    for score in scores:
        for flag in score.flags or []:
            text = flag.get("flag", "")
            if any(k in text for k in ("营养", "体重", "食欲", "肌量")):
                buckets["营养"].append(f"{score.scale_code}：{text}，建议由营养科评估并制定饮食方案。")
            elif any(k in text for k in ("行走", "步态", "起坐", "体能", "跌倒")):
                buckets["运动"].append(f"{score.scale_code}：{text}，建议在康复治疗师指导下进行平衡与力量训练。")
            elif any(k in text for k in ("服药", "用药", "多重用药")):
                buckets["用药"].append(f"{score.scale_code}：{text}，建议药师核对用药清单并做减药沟通。")
            elif any(k in text for k in ("情绪", "抑郁", "焦虑", "睡眠", "记忆", "认知", "谵妄")):
                buckets["心理"].append(f"{score.scale_code}：{text}，建议心理/精神专科评估并关注睡眠节律。")
            elif any(k in text for k in ("居家", "环境", "如厕", "洗澡", "穿衣")):
                buckets["照护"].append(f"{score.scale_code}：{text}，建议由社工评估照护资源与环境改造。")
            else:
                buckets["照护"].append(f"{score.scale_code}：{text}，请医护在随访中重点跟踪。")
    return [
        {"category": category, "items": items} for category, items in buckets.items() if items
    ]


# ---------------------------------------------------------------------------
# 业务数据组装
# ---------------------------------------------------------------------------


def build_sections(db: Session, patient_id: int, staff: User | None = None) -> dict[str, Any]:
    patient = db.get(Patient, patient_id)
    scores = _latest_scores(db, patient_id)
    templates = db.query(ScaleTemplate).all()
    scale_names = {row.code: row.name for row in templates}
    scale_dims = {row.code: row.dimension for row in templates}

    scale_results = []
    positive_list = []
    for score in scores:
        scale_results.append(
            {
                "scale_code": score.scale_code,
                "scale_name": scale_names.get(score.scale_code, score.scale_code),
                "dimension": scale_dims.get(score.scale_code, ""),
                "total": score.total,
                "level": score.level,
                "interpretation": score.interpretation,
                "abnormal": score.abnormal,
                "severity": score.severity,
                "flags": score.flags or [],
                "explanation": score.explanation,
                "rule_refs": score.rule_refs or [],
                "scale_version": score.scale_version,
                "rule_version": score.rule_version,
                "needs_manual_review": score.needs_manual_review,
            }
        )
        if score.abnormal:
            positive_list.append(
                {
                    "scale_code": score.scale_code,
                    "scale_name": scale_names.get(score.scale_code, score.scale_code),
                    "level": score.level,
                    "severity": score.severity,
                    "interpretation": score.interpretation,
                    "flags": [flag.get("flag") for flag in (score.flags or [])],
                    "need_special_assessment": bool(score.flags),
                }
            )

    periodic = (
        db.query(PeriodicAssessment)
        .filter(PeriodicAssessment.patient_id == patient_id)
        .order_by(PeriodicAssessment.generated_at.desc())
        .first()
    )
    ai_supplement = {
        "dimension_conclusions": periodic.dimension_conclusions if periodic else [],
        "trend": periodic.trend if periodic else [],
        "model": periodic.model if periodic else "",
        "prompt_version": periodic.prompt_version if periodic else "",
        "generated_at": periodic.generated_at.isoformat() if periodic else "",
        "notice": periodic.notice if periodic else "暂无 AI 补充评估记录。",
    }

    match_run = (
        db.query(MatchRun)
        .filter(MatchRun.patient_id == patient_id)
        .order_by(MatchRun.created_at.desc())
        .first()
    )
    disease_match: dict[str, Any] = {"candidates": [], "alert": {}, "disclaimer": "", "created_at": ""}
    if match_run:
        from app.db.models import MatchCandidate

        rows = (
            db.query(MatchCandidate)
            .filter(MatchCandidate.run_id == match_run.id)
            .order_by(MatchCandidate.rank)
            .all()
        )
        alert = (
            db.query(Alert).filter(Alert.match_run_id == match_run.id).order_by(Alert.id.desc()).first()
        )
        disease_match = {
            "candidates": [
                {
                    "rank": row.rank,
                    "disease_code": row.disease_code,
                    "disease_name": row.disease_name,
                    "match_score": row.match_score,
                    "ref_probability": row.ref_probability,
                    "hit_symptoms": row.hit_symptoms,
                    "missing_symptoms": row.missing_symptoms,
                    "excluded_reasons": row.excluded_reasons,
                    "red_flags": row.red_flags,
                    "distinctive_symptoms": row.distinctive_symptoms,
                    "shared_symptoms": row.shared_symptoms,
                    "risk_level": row.risk_level,
                    "advice": row.advice,
                }
                for row in rows
            ],
            "alert": {
                "level": alert.level if alert else "",
                "level_label": ALERT_LEVEL_LABELS.get(alert.level if alert else "", ""),
                "message": alert.message if alert else "",
                "department": alert.department if alert else "",
                "status": alert.status if alert else "",
            }
            if alert
            else {},
            "disclaimer": alert.disclaimer if alert else "",
            "created_at": match_run.created_at.isoformat(),
        }

    followups = db.query(Followup).filter(Followup.patient_id == patient_id).all()
    followup_plan = {
        "items": [
            {
                "id": item.id,
                "interval_days": item.interval_days,
                "due_at": item.due_at.isoformat() if item.due_at else "",
                "focus_items": item.focus_items or [],
                "status": item.status,
                "note": item.note,
            }
            for item in followups
        ],
        "trend": [],
    }

    sessions = (
        db.query(AssessmentSession)
        .filter(AssessmentSession.patient_id == patient_id)
        .order_by(AssessmentSession.started_at.desc())
        .limit(10)
        .all()
    )
    reviewers = {row.id: row.full_name for row in db.query(User).all()}

    return {
        "basic": {
            "patient_id": patient.id,
            "name": patient.name,
            "gender": patient.gender,
            "age": patient.age,
            "birth_date": patient.birth_date.isoformat() if patient.birth_date else "",
            "phone": patient.phone,
            "assessment_time": dt.datetime.now().strftime("%Y-%m-%d %H:%M"),
            "assessor": staff.full_name if staff else "系统自动",
            "organization": "示例社区卫生服务中心",
            "scale_count": len(scores),
            "scale_versions": sorted({score.scale_version for score in scores if score.scale_version}),
            "rule_versions": sorted({score.rule_version for score in scores if score.rule_version}),
            "recent_sessions": [
                {
                    "id": item.id,
                    "scale_code": item.scale_code,
                    "status": item.status,
                    "started_at": item.started_at.isoformat() if item.started_at else "",
                    "reviewer": reviewers.get(item.reviewer_id, ""),
                }
                for item in sessions
            ],
        },
        "scale_results": scale_results,
        "dimension_summary": _dimension_summary(scores, scale_dims),
        "positive_list": positive_list,
        "ai_supplement": ai_supplement,
        "disease_match": disease_match,
        "interventions": _interventions(scores),
        "mdt_opinions": [],
        "followup_plan": followup_plan,
    }


# ---------------------------------------------------------------------------
# 模板
# ---------------------------------------------------------------------------


def get_template(db: Session, code: str | None = None) -> dict:
    """取报告模板；未指定时取专业版。"""
    query = db.query(ReportTemplate)
    if code:
        row = query.filter(ReportTemplate.code == code).first()
    else:
        row = query.filter(ReportTemplate.scene == "professional").first() or query.first()
    if row is None:
        return DEFAULT_TEMPLATE
    payload = dict(row.payload or {})
    payload.setdefault("cover", {})
    payload.setdefault("toc", [])
    payload.setdefault("blocks", [])
    payload.setdefault("signatures", [])
    payload.setdefault("header", {})
    payload.setdefault("footer", {})
    payload.setdefault("disclaimer", REPORT_DISCLAIMER)
    return payload


DEFAULT_TEMPLATE: dict = {
    "cover": {"title": "老年综合评估报告", "subtitle": "", "fields": [], "footer": ""},
    "toc": [],
    "blocks": [{"ref": "basic", "type": "kv", "title": "一、基本信息", "source": "basic", "fields": []}],
    "signatures": [],
    "header": {},
    "footer": {},
    "disclaimer": REPORT_DISCLAIMER,
}


# ---------------------------------------------------------------------------
# 文档模型
# ---------------------------------------------------------------------------


def _stringify(value: Any) -> str:
    if value is None:
        return "—"
    if isinstance(value, bool):
        return "是" if value else "否"
    if isinstance(value, (list, tuple)):
        return "、".join(_stringify(item) for item in value) if value else "—"
    if isinstance(value, dict):
        return "、".join(str(item) for item in value.values()) if value else "—"
    return str(value) if str(value) else "—"


def build_document(sections: dict, template: dict, title: str = "") -> dict[str, Any]:
    """业务数据 + 模板 → 文档模型（Word/PDF 的共同中间层）。"""
    blocks: list[dict] = []
    for block in template.get("blocks", []):
        source = sections.get(block.get("source", ""), None)
        kind = block.get("type", "paragraph")
        title_text = block.get("title", "")

        if kind == "kv":
            rows = [
                [field.get("label", field.get("key", "")), _stringify(source.get(field.get("key", "")))]
                for field in block.get("fields", [])
            ] if isinstance(source, dict) else []
            blocks.append({"type": "kv", "title": title_text, "rows": rows})
        elif kind == "table":
            columns = block.get("columns", [])
            rows = []
            for item in source or []:
                rows.append([_stringify(item.get(column.get("key", ""))) for column in columns])
            blocks.append(
                {
                    "type": "table",
                    "title": title_text,
                    "columns": [column.get("label", "") for column in columns],
                    "rows": rows,
                }
            )
        elif kind == "detail":
            items = []
            for item in source or []:
                lines = [f"{item.get('scale_code','')} {item.get('scale_name','')}：{item.get('interpretation','')}"]
                if item.get("explanation"):
                    lines.append(f"判读依据：{item['explanation']}")
                for flag in item.get("flags", []) or []:
                    severity = SEVERITY_LABELS.get(flag.get("severity", ""), flag.get("severity", ""))
                    lines.append(f"　· 阳性项：{flag.get('flag','')}（{severity}）")
                refs = item.get("rule_refs", []) or []
                for ref in refs[:2]:
                    detail = ref.get("explanation") or f"{ref.get('rule','')}"
                    items_detail = ref.get("items") or []
                    if items_detail:
                        detail += "；" + "，".join(
                            f"{one.get('label','')}={one.get('value','')}({one.get('score','')})"
                            for one in items_detail[:10]
                        )
                    lines.append(f"　· 规则回溯：{detail}")
                items.append("\n".join(lines))
            blocks.append({"type": "list", "title": title_text, "items": items})
        elif kind == "dimension":
            items = [
                f"{item.get('dimension','')}：{item.get('conclusion','')}" for item in source or []
            ]
            blocks.append({"type": "list", "title": title_text, "items": items})
        elif kind == "notice":
            notice = (source or {}).get(block.get("notice_key", "notice"), "")
            items = []
            for item in (source or {}).get(block.get("items_key", ""), []) or []:
                label = item.get(block.get("item_fields", ["dimension", "conclusion"])[0], "")
                text = item.get(block.get("item_fields", ["dimension", "conclusion"])[1], "")
                items.append(f"{label}：{text}")
            blocks.append({"type": "notice", "title": title_text, "text": notice, "items": items})
        elif kind == "match":
            items = []
            for candidate in (source or {}).get("candidates", []) or []:
                hits = "、".join(item.get("term", "") for item in candidate.get("hit_symptoms", []) or []) or "—"
                distinctive = (
                    "、".join(item.get("term", "") for item in candidate.get("distinctive_symptoms", []) or []) or "—"
                )
                missing = "、".join(item.get("term", "") for item in candidate.get("missing_symptoms", []) or []) or "—"
                items.append(
                    f"候选{candidate.get('rank')} {candidate.get('disease_name','')}："
                    f"匹配度 {candidate.get('match_score')}，参考概率 {candidate.get('ref_probability')}；"
                    f"命中 {hits}；区分性线索 {distinctive}；缺失关键症状 {missing}"
                )
            alert = (source or {}).get("alert") or {}
            if alert:
                items.append(
                    f"就医提醒（{alert.get('level_label') or alert.get('level','')}）：{alert.get('message','')}"
                )
            blocks.append({"type": "list", "title": title_text, "items": items})
        elif kind == "plain_match":
            items = []
            for candidate in (source or {}).get("candidates", []) or []:
                advice = (candidate.get("advice") or {}).get("text", "")
                items.append(f"· {candidate.get('disease_name','')}：{advice}")
            alert = (source or {}).get("alert") or {}
            if alert:
                items.append(f"【{alert.get('level_label') or alert.get('level','')}】{alert.get('message','')}")
            blocks.append({"type": "list", "title": title_text, "items": items})
        elif kind == "plain_scales":
            items = []
            for item in source or []:
                mark = "需要注意" if item.get("abnormal") else "情况良好"
                items.append(f"· {item.get('scale_name','')}：{mark}（{item.get('interpretation','')}）")
            blocks.append({"type": "list", "title": title_text, "items": items})
        elif kind == "plain_positive":
            items = []
            for item in source or []:
                flags = "、".join(item.get("flags") or []) or "—"
                items.append(f"· {item.get('scale_name','')}：{item.get('interpretation','')}（{flags}）")
            blocks.append({"type": "list", "title": title_text, "items": items})
        elif kind == "categories":
            items = []
            for group in source or []:
                items.append(f"【{group.get('category','')}】")
                items.extend(f"　· {advice}" for advice in group.get("items", []))
            blocks.append({"type": "list", "title": title_text, "items": items})
        elif kind == "mdt":
            items = [
                f"· {item.get('role','')}：{item.get('opinion','')}" for item in source or []
            ] or ["暂未录入，可在复核环节补充各角色意见。"]
            blocks.append({"type": "list", "title": title_text, "items": items})
        elif kind == "followup":
            items = []
            for item in (source or {}).get("items", []) or []:
                focus = "、".join(item.get("focus_items") or []) or "常规复评"
                items.append(
                    f"· {item.get('interval_days','')} 天后复评（状态 {item.get('status','')}），重点：{focus}"
                )
            blocks.append(
                {"type": "list", "title": title_text, "items": items or ["待制定"]}
            )
        else:
            blocks.append({"type": "paragraph", "title": title_text, "text": _stringify(source)})

    cover = dict(template.get("cover", {}))
    cover.setdefault("title", title or "老年综合评估报告")
    cover["fields"] = [
        [field.get("label", ""), _stringify(sections.get("basic", {}).get(field.get("key", "")))]
        for field in cover.get("fields", [])
    ]

    return {
        "title": title or cover.get("title", "老年综合评估报告"),
        "cover": cover,
        "toc": template.get("toc", []),
        "blocks": blocks,
        "signatures": template.get("signatures", []),
        "header": template.get("header", {}),
        "footer": template.get("footer", {}),
        "disclaimer": template.get("disclaimer", REPORT_DISCLAIMER),
    }


# ---------------------------------------------------------------------------
# 报告生成
# ---------------------------------------------------------------------------


def create_report(
    db: Session,
    patient_id: int,
    staff: User | None = None,
    title: str = "",
    template_code: str | None = None,
) -> CgaReport:
    latest = (
        db.query(CgaReport)
        .filter(CgaReport.patient_id == patient_id)
        .order_by(CgaReport.version.desc())
        .first()
    )
    version = (latest.version + 1) if latest else 1
    sections = build_sections(db, patient_id, staff)
    template = get_template(db, template_code)
    report = CgaReport(
        patient_id=patient_id,
        version=version,
        title=title or f"{sections['basic']['name']} {template.get('cover', {}).get('title', '老年综合评估报告')}",
        sections=sections,
        disclaimer=template.get("disclaimer", REPORT_DISCLAIMER),
        locked=False,
        created_by=staff.id if staff else None,
    )
    report.template_code = template_code or "professional"
    db.add(report)
    db.commit()
    db.refresh(report)
    return report


# ---------------------------------------------------------------------------
# 导出
# ---------------------------------------------------------------------------


def export_docx(sections: dict, title: str, template: dict | None = None) -> bytes:
    from docx import Document
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.shared import Pt

    template = template or DEFAULT_TEMPLATE
    model = build_document(sections, template, title)
    document = Document()
    style = document.styles["Normal"]
    style.font.name = "SimSun"
    style.font.size = Pt(10.5)

    # 封面
    heading = document.add_paragraph()
    heading.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = heading.add_run(model["cover"].get("title", "老年综合评估报告"))
    run.bold = True
    run.font.size = Pt(20)
    subtitle = model["cover"].get("subtitle")
    if subtitle:
        sub = document.add_paragraph()
        sub.alignment = WD_ALIGN_PARAGRAPH.CENTER
        sub_run = sub.add_run(subtitle)
        sub_run.font.size = Pt(11)
    for label, value in model["cover"].get("fields", []):
        paragraph = document.add_paragraph()
        paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
        paragraph.add_run(f"{label}：{value}")
    if model["cover"].get("footer"):
        paragraph = document.add_paragraph()
        paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
        footer_run = paragraph.add_run(model["cover"]["footer"])
        footer_run.italic = True
        footer_run.font.size = Pt(9)
    document.add_page_break()

    # 目录
    if model["toc"]:
        toc_title = document.add_paragraph()
        toc_run = toc_title.add_run("目录")
        toc_run.bold = True
        toc_run.font.size = Pt(14)
        for entry in model["toc"]:
            document.add_paragraph(f"{entry.get('label','')}")
        document.add_page_break()

    for block in model["blocks"]:
        if block.get("title"):
            paragraph = document.add_paragraph()
            run = paragraph.add_run(block["title"])
            run.bold = True
            run.font.size = Pt(12)
        if block["type"] == "kv":
            for label, value in block["rows"]:
                paragraph = document.add_paragraph()
                paragraph.add_run(f"{label}：").bold = True
                paragraph.add_run(str(value))
        elif block["type"] == "table":
            if block["rows"]:
                table = document.add_table(rows=1, cols=len(block["columns"]))
                table.style = "Table Grid"
                for index, column in enumerate(block["columns"]):
                    cell = table.rows[0].cells[index]
                    cell.text = str(column)
                for row in block["rows"]:
                    cells = table.add_row().cells
                    for index, value in enumerate(row[: len(block["columns"])]):
                        cells[index].text = str(value)
        elif block["type"] == "list":
            for item in block["items"]:
                document.add_paragraph(str(item))
        elif block["type"] == "notice":
            paragraph = document.add_paragraph()
            run = paragraph.add_run(block.get("text", ""))
            run.italic = True
            run.font.size = Pt(9)
            for item in block["items"]:
                document.add_paragraph(str(item))
        else:
            document.add_paragraph(block.get("text", ""))

    if model["signatures"]:
        document.add_paragraph()
        for signature in model["signatures"]:
            paragraph = document.add_paragraph()
            paragraph.add_run(f"{signature.get('role','')}：________________")
    paragraph = document.add_paragraph()
    run = paragraph.add_run(model["disclaimer"])
    run.italic = True
    run.font.size = Pt(9)

    buffer = io.BytesIO()
    document.save(buffer)
    return buffer.getvalue()


def export_pdf(sections: dict, title: str, template: dict | None = None) -> bytes:
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    from reportlab.platypus import (
        PageBreak,
        Paragraph,
        SimpleDocTemplate,
        Spacer,
        Table,
        TableStyle,
    )

    template = template or DEFAULT_TEMPLATE
    model = build_document(sections, template, title)

    pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle(
        "CGA title", parent=styles["Title"], fontName="STSong-Light", fontSize=20, leading=28, spaceAfter=10
    )
    subtitle_style = ParagraphStyle(
        "CGA subtitle", parent=styles["Normal"], fontName="STSong-Light", fontSize=11, leading=16, alignment=1
    )
    heading_style = ParagraphStyle(
        "CGA heading", parent=styles["Normal"], fontName="STSong-Light", fontSize=12.5, leading=18, spaceBefore=10, spaceAfter=5
    )
    body_style = ParagraphStyle(
        "CGA body", parent=styles["Normal"], fontName="STSong-Light", fontSize=9.5, leading=15
    )
    note_style = ParagraphStyle(
        "CGA note", parent=styles["Normal"], fontName="STSong-Light", fontSize=8.5, leading=12, textColor="#555555"
    )
    cell_style = ParagraphStyle(
        "CGA cell", parent=styles["Normal"], fontName="STSong-Light", fontSize=8.5, leading=12
    )

    buffer = io.BytesIO()
    document = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        leftMargin=20 * mm,
        rightMargin=20 * mm,
        topMargin=22 * mm,
        bottomMargin=20 * mm,
        title=model["title"],
        author="老年人就医预问诊与老年综合评估系统",
    )

    story: list[Any] = []
    # 封面
    story.append(Spacer(1, 45 * mm))
    story.append(Paragraph(model["cover"].get("title", "老年综合评估报告"), title_style))
    if model["cover"].get("subtitle"):
        story.append(Paragraph(model["cover"]["subtitle"], subtitle_style))
    story.append(Spacer(1, 12 * mm))
    for label, value in model["cover"].get("fields", []):
        story.append(Paragraph(f"{label}：{value}", subtitle_style))
    story.append(Spacer(1, 20 * mm))
    if model["cover"].get("footer"):
        story.append(Paragraph(model["cover"]["footer"], note_style))
    story.append(PageBreak())

    # 目录
    if model["toc"]:
        story.append(Paragraph("目录", heading_style))
        for entry in model["toc"]:
            story.append(Paragraph(entry.get("label", ""), body_style))
        story.append(PageBreak())

    # 正文
    for block in model["blocks"]:
        if block.get("title"):
            story.append(Paragraph(block["title"], heading_style))
        if block["type"] == "kv":
            rows = [[Paragraph(label, cell_style), Paragraph(str(value), cell_style)] for label, value in block["rows"]]
            if rows:
                table = Table(rows, colWidths=[35 * mm, 115 * mm])
                table.setStyle(
                    TableStyle(
                        [
                            ("FONTNAME", (0, 0), (-1, -1), "STSong-Light"),
                            ("FONTSIZE", (0, 0), (-1, -1), 9),
                            ("VALIGN", (0, 0), (-1, -1), "TOP"),
                            ("GRID", (0, 0), (-1, -1), 0.4, "#CCCCCC"),
                            ("BACKGROUND", (0, 0), (0, -1), "#F5F7FA"),
                        ]
                    )
                )
                story.append(table)
        elif block["type"] == "table":
            if block["rows"]:
                data = [[Paragraph(str(column), cell_style) for column in block["columns"]]]
                for row in block["rows"]:
                    data.append([Paragraph(str(value), cell_style) for value in row[: len(block["columns"])]])
                table = Table(data, repeatRows=1)
                table.setStyle(
                    TableStyle(
                        [
                            ("FONTNAME", (0, 0), (-1, -1), "STSong-Light"),
                            ("FONTSIZE", (0, 0), (-1, -1), 8.5),
                            ("VALIGN", (0, 0), (-1, -1), "TOP"),
                            ("GRID", (0, 0), (-1, -1), 0.4, "#CCCCCC"),
                            ("BACKGROUND", (0, 0), (-1, 0), "#EEF2F7"),
                        ]
                    )
                )
                story.append(table)
        elif block["type"] == "list":
            for item in block["items"]:
                story.append(Paragraph(str(item).replace("\n", "<br/>"), body_style))
        elif block["type"] == "notice":
            story.append(Paragraph(block.get("text", ""), note_style))
            for item in block["items"]:
                story.append(Paragraph(str(item), body_style))
        else:
            story.append(Paragraph(block.get("text", ""), body_style))
        story.append(Spacer(1, 2 * mm))

    if model["signatures"]:
        story.append(Spacer(1, 8 * mm))
        signature_rows = [
            [Paragraph(f"{item.get('role','')}：____________________", cell_style)] for item in model["signatures"]
        ]
        table = Table(signature_rows, colWidths=[80 * mm])
        table.setStyle(TableStyle([("FONTNAME", (0, 0), (-1, -1), "STSong-Light"), ("FONTSIZE", (0, 0), (-1, -1), 9.5)]))
        story.append(table)

    story.append(Spacer(1, 6 * mm))
    story.append(Paragraph(model["disclaimer"], note_style))

    header_text = model.get("header", {})
    footer_text = model.get("footer", {})

    def draw_frame(canvas, doc):
        canvas.saveState()
        page = canvas.getPageNumber()
        if page > 1:
            if header_text.get("left") or header_text.get("right"):
                canvas.setFont("STSong-Light", 8)
                canvas.drawString(20 * mm, A4[1] - 14 * mm, str(header_text.get("left", "")))
                if header_text.get("right"):
                    canvas.drawRightString(A4[0] - 20 * mm, A4[1] - 14 * mm, str(header_text.get("right")))
                canvas.setStrokeColor("#DDDDDD")
                canvas.line(20 * mm, A4[1] - 16 * mm, A4[0] - 20 * mm, A4[1] - 16 * mm)
            canvas.setFont("STSong-Light", 8)
            if footer_text.get("left"):
                canvas.drawString(20 * mm, 12 * mm, str(footer_text["left"]))
            right = str(footer_text.get("right", "")).replace("X", str(page)).replace("Y", str(doc.page))
            canvas.drawRightString(A4[0] - 20 * mm, 12 * mm, right)
        canvas.restoreState()

    document.build(story, onFirstPage=draw_frame, onLaterPages=draw_frame)
    return buffer.getvalue()
