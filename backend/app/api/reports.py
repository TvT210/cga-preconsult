"""综合评估报告：生成、查询、版本锁定与导出。"""

from __future__ import annotations

from urllib.parse import quote

from fastapi import Depends, HTTPException, Response
from sqlalchemy.orm import Session

from app.api import new_router

router = new_router()
from app.core.deps import ROLE_ELDER, ensure_patient_access, get_current_user, require_staff
from app.db.base import get_db
from app.db.models import CgaReport, ReportTemplate, User
from app.services import audit, report as report_service


def _payload(row: CgaReport) -> dict:
    return {
        "id": row.id,
        "patient_id": row.patient_id,
        "version": row.version,
        "title": row.title,
        "template_code": row.template_code,
        "locked": row.locked,
        "sections": row.sections,
        "disclaimer": row.disclaimer,
        "created_at": row.created_at.isoformat(),
    }


@router.post("/reports")
def create_report(
    payload: dict,
    user: User = Depends(require_staff),
    db: Session = Depends(get_db),
):
    patient_id = int(payload.get("patient_id") or 0)
    if not patient_id:
        raise HTTPException(status_code=400, detail="缺少 patient_id")
    row = report_service.create_report(
        db,
        patient_id,
        user,
        payload.get("title", ""),
        payload.get("template_code"),
    )
    audit.record(db, user, "create", "report", row.id, {"patient_id": patient_id, "version": row.version})
    db.commit()
    return _payload(row)


@router.get("/report-templates")
def list_report_templates(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """报告模板清单（专业版 / 通俗版 / 存档版）。"""
    rows = db.query(ReportTemplate).order_by(ReportTemplate.id).all()
    return [
        {
            "code": row.code,
            "name": row.name,
            "version": row.version,
            "scene": row.scene,
            "review_status": row.review_status,
            "active": row.active,
            "created_at": row.created_at.isoformat(),
        }
        for row in rows
    ]


@router.get("/reports")
def list_reports(
    patient_id: int = 0,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    query = db.query(CgaReport)
    if user.role == ROLE_ELDER:
        # 老人只能看到本人数据；未绑定患者时返回空集
        query = query.filter(CgaReport.patient_id == (user.patient_id if user.patient_id is not None else -1))
    if patient_id:
        ensure_patient_access(user, patient_id)
        query = query.filter(CgaReport.patient_id == patient_id)
    rows = query.order_by(CgaReport.id.desc()).all()
    return [
        {
            "id": row.id,
            "patient_id": row.patient_id,
            "version": row.version,
            "title": row.title,
            "template_code": row.template_code,
            "locked": row.locked,
            "created_at": row.created_at.isoformat(),
        }
        for row in rows
    ]


@router.get("/reports/{report_id}")
def get_report(
    report_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    row = db.get(CgaReport, report_id)
    if row is None:
        raise HTTPException(status_code=404, detail="报告不存在")
    ensure_patient_access(user, row.patient_id)
    audit.record(db, user, "view", "report", report_id)
    db.commit()
    return _payload(row)


@router.post("/reports/{report_id}/lock")
def lock_report(
    report_id: int,
    user: User = Depends(require_staff),
    db: Session = Depends(get_db),
):
    """归档锁定版本；后续修改需新建版本并留痕。"""
    row = db.get(CgaReport, report_id)
    if row is None:
        raise HTTPException(status_code=404, detail="报告不存在")
    if row.locked:
        raise HTTPException(status_code=400, detail="报告已锁定，请新建版本")
    row.locked = True
    db.commit()
    audit.record(db, user, "lock", "report", report_id, {"version": row.version})
    db.commit()
    return _payload(row)


@router.get("/reports/{report_id}/export")
def export_report(
    report_id: int,
    format: str = "docx",
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    row = db.get(CgaReport, report_id)
    if row is None:
        raise HTTPException(status_code=404, detail="报告不存在")
    ensure_patient_access(user, row.patient_id)
    if format not in {"docx", "pdf"}:
        raise HTTPException(status_code=400, detail="format 仅支持 docx 或 pdf")
    title = row.title
    template = report_service.get_template(db, row.template_code)
    if format == "pdf":
        content = report_service.export_pdf(row.sections, title, template)
        media_type = "application/pdf"
    else:
        content = report_service.export_docx(row.sections, title, template)
        media_type = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    filename = f"cga_report_{row.patient_id}_v{row.version}.{format}"
    audit.record(db, user, "export", "report", report_id, {"format": format, "template": row.template_code})
    db.commit()
    return Response(
        content=content,
        media_type=media_type,
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}"},
    )
