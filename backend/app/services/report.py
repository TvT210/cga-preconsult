"""老年综合评估报告：内容组装 + Word/PDF 导出。

报告内容按需求 §5.9 分区；导出后归档时锁定版本，修改需新建版本并留痕。
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
    ScaleTemplate,
    User,
)

REPORT_DISCLAIMER = "本报告由老年人就医预问诊与老年综合评估系统生成，结果仅供参考，不构成诊断，请结合临床检查由医师判断。"

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
                    {"scale_code": s.scale_code, "level": s.level, "interpretation": s.interpretation}
                    for s in abnormal
                ],
            }
        )
    return summary


def _interventions(scores: list[AssessmentScore]) -> list[dict]:
    """由阳性标记推导可执行建议（按维度分组）。"""
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
        {"category": category, "items": items}
        for category, items in buckets.items()
        if items
    ]


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
    disease_match = {"candidates": [], "alert": {}, "disclaimer": ""}
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
                    "risk_level": row.risk_level,
                    "advice": row.advice,
                }
                for row in rows
            ],
            "alert": {
                "level": alert.level if alert else "",
                "message": alert.message if alert else "",
                "department": alert.department if alert else "",
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


def create_report(db: Session, patient_id: int, staff: User | None = None, title: str = "") -> CgaReport:
    latest = (
        db.query(CgaReport)
        .filter(CgaReport.patient_id == patient_id)
        .order_by(CgaReport.version.desc())
        .first()
    )
    version = (latest.version + 1) if latest else 1
    sections = build_sections(db, patient_id, staff)
    report = CgaReport(
        patient_id=patient_id,
        version=version,
        title=title or f"{sections['basic']['name']} 老年综合评估报告",
        sections=sections,
        disclaimer=REPORT_DISCLAIMER,
        locked=False,
        created_by=staff.id if staff else None,
    )
    db.add(report)
    db.commit()
    db.refresh(report)
    return report


# ---------------------------------------------------------------- 导出

def _flatten_sections(sections: dict) -> list[tuple[str, str]]:
    lines: list[tuple[str, str]] = []
    basic = sections.get("basic", {})
    lines.append(("基本信息", ""))
    for key in ("name", "gender", "age", "assessment_time", "assessor", "organization"):
        label = {
            "name": "姓名",
            "gender": "性别",
            "age": "年龄",
            "assessment_time": "评估时间",
            "assessor": "施测人",
            "organization": "机构",
        }[key]
        lines.append((label, str(basic.get(key, ""))))
    lines.append(("量表版本", "、".join(basic.get("scale_versions", []) or [])))
    lines.append(("规则版本", "、".join(basic.get("rule_versions", []) or [])))

    lines.append(("量表结果", ""))
    for item in sections.get("scale_results", []):
        lines.append(
            (
                f"{item['scale_code']} {item['scale_name']}",
                f"总分 {item['total']}，判读：{item['level']}。{item['interpretation']}",
            )
        )
        for flag in item.get("flags", []):
            severity = SEVERITY_LABELS.get(flag.get("severity", ""), flag.get("severity", ""))
            lines.append(("　· 阳性项", f"{flag.get('flag','')}（{severity}）"))

    lines.append(("维度小结", ""))
    for item in sections.get("dimension_summary", []):
        lines.append((item["dimension"], item["conclusion"]))

    lines.append(("阳性问题清单", ""))
    for item in sections.get("positive_list", []):
        flags = "、".join(item.get("flags") or []) or "—"
        lines.append((f"{item['scale_code']} {item['scale_name']}", f"{item['level']}｜{flags}｜{item['interpretation']}"))

    lines.append(("AI 补充评估", sections.get("ai_supplement", {}).get("notice", "")))
    for item in sections.get("ai_supplement", {}).get("dimension_conclusions", []):
        lines.append((item.get("dimension", ""), item.get("conclusion", "")))

    lines.append(("疾病匹配", ""))
    match = sections.get("disease_match", {})
    for item in match.get("candidates", []) or []:
        hits = "、".join(hit.get("term", hit.get("code", "")) for hit in item.get("hit_symptoms", []) or []) or "—"
        missing = "、".join(miss.get("term", miss.get("code", "")) for miss in item.get("missing_symptoms", []) or []) or "—"
        lines.append(
            (
                f"候选{item.get('rank')}：{item.get('disease_name')}",
                f"匹配度 {item.get('match_score')}，参考概率 {item.get('ref_probability')}；命中：{hits}；缺失关键症状：{missing}",
            )
        )
    alert = match.get("alert") or {}
    if alert:
        level_label = ALERT_LEVEL_LABELS.get(alert.get("level", ""), alert.get("level", ""))
        lines.append(("就医提醒", f"[{level_label}] {alert.get('message','')}"))

    lines.append(("干预建议", ""))
    for item in sections.get("interventions", []) or []:
        for advice in item.get("items", []):
            lines.append((item.get("category", ""), advice))

    lines.append(("多学科意见", "暂未录入，可在复核环节补充各角色意见。"))
    followup = sections.get("followup_plan", {}).get("items", [])
    lines.append(("随访计划", "；".join(f"{f.get('interval_days')} 天后复评（{f.get('status')}）" for f in followup) or "待制定"))
    return lines


def export_docx(sections: dict, title: str) -> bytes:
    from docx import Document
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.shared import Pt

    document = Document()
    style = document.styles["Normal"]
    style.font.name = "SimSun"
    style.font.size = Pt(10.5)

    heading = document.add_paragraph(title)
    heading.alignment = WD_ALIGN_PARAGRAPH.CENTER
    heading.runs[0].bold = True
    heading.runs[0].font.size = Pt(16)

    for label, value in _flatten_sections(sections):
        if value == "":
            paragraph = document.add_paragraph()
            run = paragraph.add_run(label)
            run.bold = True
            run.font.size = Pt(12)
            continue
        paragraph = document.add_paragraph()
        paragraph.add_run(f"{label}：").bold = True
        paragraph.add_run(value)

    paragraph = document.add_paragraph()
    run = paragraph.add_run(REPORT_DISCLAIMER)
    run.italic = True
    run.font.size = Pt(9)

    buffer = io.BytesIO()
    document.save(buffer)
    return buffer.getvalue()


def export_pdf(sections: dict, title: str) -> bytes:
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer

    pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle("CGA title", parent=styles["Title"], fontName="STSong-Light", fontSize=16, leading=22)
    label_style = ParagraphStyle("CGA label", parent=styles["Normal"], fontName="STSong-Light", fontSize=9.5, leading=14)
    note_style = ParagraphStyle("CGA note", parent=styles["Normal"], fontName="STSong-Light", fontSize=8.5, leading=12, textColor="#555555")

    buffer = io.BytesIO()
    document = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        leftMargin=20 * mm,
        rightMargin=20 * mm,
        topMargin=18 * mm,
        bottomMargin=18 * mm,
        title=title,
        author="老年人就医预问诊与老年综合评估系统",
    )
    story: list[Any] = [Paragraph(title, title_style), Spacer(1, 6 * mm)]
    for label, value in _flatten_sections(sections):
        if value == "":
            story.append(Paragraph(f"<b>{label}</b>", label_style))
            story.append(Spacer(1, 2 * mm))
            continue
        story.append(Paragraph(f"<b>{label}：</b>{value}", label_style))
        story.append(Spacer(1, 1.5 * mm))
    story.append(Spacer(1, 3 * mm))
    story.append(Paragraph(REPORT_DISCLAIMER, note_style))
    document.build(story)
    return buffer.getvalue()
