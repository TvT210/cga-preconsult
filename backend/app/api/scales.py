"""量表中心：清单、详情、版本与评审。"""

from __future__ import annotations

from fastapi import Depends, HTTPException
from sqlalchemy.orm import Session

from app.api import new_router

router = new_router()
from app.core.deps import ROLE_ADMIN, ROLE_DOCTOR, get_current_user, require_roles
from app.db.base import get_db
from app.db.models import ScaleTemplate, ScaleVersion, TemplateApproval, User
from app.services import audit, plain_text, scale_review
from app.services.scale_presenter import present_scale
from app.services.scales_store import get_scale, list_scales
from packages.medagent.llm import get_provider

REVIEW_STATES = {"draft_pending_medical_review", "approved", "deprecated"}


@router.get("/scales")
def get_scales(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return list_scales(db)


# 注意：本条必须声明在 `/scales/{code}` 之前，否则 "approvals" 会被当成量表编号。
@router.get("/scales/approvals")
def list_approvals(
    code: str = "",
    limit: int = 50,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """审批记录（签字人、凭据、录入人分开返回）。"""
    query = db.query(TemplateApproval).filter(TemplateApproval.target_type == "scale")
    if code:
        query = query.filter(TemplateApproval.target_id == code)
    rows = query.order_by(TemplateApproval.id.desc()).limit(min(max(limit, 1), 300)).all()
    return [
        {
            "id": row.id,
            "code": row.target_id,
            "action": row.action,
            "reviewer": row.reviewer,
            "reviewer_title": row.reviewer_title or "",
            "evidence_type": row.evidence_type or "",
            "evidence_label": scale_review.evidence_label(row.evidence_type),
            "operator": row.operator or "",
            "reviewed_at": row.reviewed_at.isoformat() if row.reviewed_at else "",
            "comment": row.comment or "",
            "created_at": row.created_at.isoformat() if row.created_at else "",
        }
        for row in rows
    ]


@router.post("/scales/reviews/batch")
def review_scales_batch(
    payload: dict,
    user: User = Depends(require_roles(ROLE_ADMIN, ROLE_DOCTOR)),
    db: Session = Depends(get_db),
):
    """批量落评审（21 张量表逐张签字时用）。

    刻意要求 `codes` 显式给出，不提供「默认全部」——一次误操作把 21 张
    全推到 approved 的代价太大，多一步勾选是值得的。
    """
    codes = payload.get("codes")
    if not isinstance(codes, list) or not codes:
        raise HTTPException(status_code=400, detail="请显式列出要评审的量表编号，不支持默认全部")
    clean = [str(item).strip() for item in codes if str(item).strip()]
    if not clean:
        raise HTTPException(status_code=400, detail="量表编号不能为空")
    status = payload.get("review_status", "approved")
    if status not in REVIEW_STATES:
        raise HTTPException(status_code=400, detail=f"评审状态必须是 {sorted(REVIEW_STATES)}")
    try:
        scale_review.parse_reviewed_at(payload.get("reviewed_at"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return scale_review.apply_batch(
        db,
        codes=clean,
        status=status,
        reviewer_name=payload.get("reviewer", ""),
        reviewer_title=payload.get("reviewer_title", ""),
        evidence_type=payload.get("evidence_type", ""),
        comment=payload.get("comment", ""),
        reviewed_at=payload.get("reviewed_at"),
        actor=user,
    )


@router.get("/scales/{code}")
def get_scale_detail(code: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    scale = get_scale(db, code)
    if scale is None:
        raise HTTPException(status_code=404, detail="量表不存在")
    item_count = sum(len(section.get("questions", [])) for section in scale.get("sections", []))
    # 表示层展开：把 measure.unit/hint 提到顶层，并标注实测分档题与兜底选项
    scale = present_scale(scale)
    scale["item_count"] = item_count
    scale["ready_for_scoring"] = item_count > 0
    row = db.query(ScaleTemplate).filter(ScaleTemplate.code == code).first()
    if row is not None:
        scale["review"] = scale_review.review_payload(row)
    if item_count == 0:
        scale["notice"] = "题库条目待以 WS/T 888—2026 附录 B 原文补录，暂不可采集与计分。"
    return scale


@router.get("/scales/{code}/versions")
def list_versions(code: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = (
        db.query(ScaleVersion)
        .filter(ScaleVersion.scale_code == code)
        .order_by(ScaleVersion.id.desc())
        .all()
    )
    return [
        {
            "id": row.id,
            "scale_code": row.scale_code,
            "version": row.version,
            "reviewer": row.reviewer,
            "comment": row.comment,
            "created_at": row.created_at.isoformat(),
        }
        for row in rows
    ]


@router.post("/scales")
def create_scale(
    payload: dict,
    user: User = Depends(require_roles(ROLE_ADMIN, ROLE_DOCTOR)),
    db: Session = Depends(get_db),
):
    code = (payload.get("code") or "").strip()
    if not code:
        raise HTTPException(status_code=400, detail="量表编号不能为空")
    if db.query(ScaleTemplate).filter(ScaleTemplate.code == code).first():
        raise HTTPException(status_code=400, detail="量表编号已存在")
    row = ScaleTemplate(
        code=code,
        name=payload.get("name", code),
        dimension=payload.get("dimension", ""),
        method=payload.get("method", ""),
        standard_ref=payload.get("standard_ref", ""),
        version=payload.get("version", "0.1.0-draft"),
        review_status=payload.get("review_status", "draft_pending_medical_review"),
        payload=payload,
    )
    db.add(row)
    db.add(
        ScaleVersion(
            scale_code=code,
            version=row.version,
            payload=payload,
            reviewer=user.full_name or user.username,
            comment="新建量表版本",
            created_by=user.id,
        )
    )
    db.commit()
    audit.record(db, user, "create", "scale", code, {"name": row.name})
    db.commit()
    return {"code": code, "id": row.id, "review_status": row.review_status}


@router.put("/scales/{code}/review")
def review_scale(
    code: str,
    payload: dict,
    user: User = Depends(require_roles(ROLE_ADMIN, ROLE_DOCTOR)),
    db: Session = Depends(get_db),
):
    """评审状态变更（题库/规则上线前审批）。

    `reviewer` 指**签字人**，不是操作人；操作人由当前账号自动记到 `operator`。
    外部专家没有系统账号时，这一区分是审批记录能不能用的前提。
    """
    status = payload.get("review_status")
    if status not in REVIEW_STATES:
        raise HTTPException(status_code=400, detail=f"评审状态必须是 {sorted(REVIEW_STATES)}")
    try:
        item = scale_review.apply_review(
            db,
            code=code,
            status=status,
            reviewer_name=payload.get("reviewer", ""),
            reviewer_title=payload.get("reviewer_title", ""),
            evidence_type=payload.get("evidence_type", ""),
            comment=payload.get("comment", ""),
            reviewed_at=payload.get("reviewed_at"),
            actor=user,
        )
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    db.commit()
    return {
        "code": code,
        "review_status": item["review"]["review_status"],
        "result": item["result"],
        "review": item["review"],
    }


# ---------------------------------------------------------------------------
# 题目口语化（A-4）：生成候选 → 审批 → 回写 plain_text
# ---------------------------------------------------------------------------


@router.get("/scales/{code}/plain-text/draft")
def get_plain_text_draft(
    code: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """查看待审批的改写候选（不覆盖已评审文案）。"""
    try:
        return plain_text.draft_status(db, code)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/scales/{code}/plain-text/draft")
def generate_plain_text_draft(
    code: str,
    payload: dict,
    user: User = Depends(require_roles(ROLE_ADMIN, ROLE_DOCTOR)),
    db: Session = Depends(get_db),
):
    """生成改写候选。

    产出只进候选池：题库里已评审的 `plain_text` 不会被改动，
    必须再走一次 `apply` 审批才生效。
    """
    codes = payload.get("question_codes")
    if codes is not None and not isinstance(codes, list):
        raise HTTPException(status_code=400, detail="question_codes 必须是数组")
    try:
        return plain_text.generate_candidates(
            db,
            code=code,
            question_codes=codes,
            provider=get_provider(),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/scales/{code}/plain-text/apply")
def apply_plain_text(
    code: str,
    payload: dict,
    user: User = Depends(require_roles(ROLE_ADMIN, ROLE_DOCTOR)),
    db: Session = Depends(get_db),
):
    """审批通过后回写题库。

    与量表评审共用同一套凭据校验：`reviewer` 是签字人，`operator` 是录入人。
    """
    items = payload.get("items")
    if not isinstance(items, list) or not items:
        raise HTTPException(status_code=400, detail="请提供要回写的题目与文案")
    try:
        return plain_text.apply_candidates(
            db,
            code=code,
            items=items,
            reviewer_name=payload.get("reviewer", ""),
            reviewer_title=payload.get("reviewer_title", ""),
            evidence_type=payload.get("evidence_type", ""),
            comment=payload.get("comment", ""),
            reviewed_at=payload.get("reviewed_at"),
            actor=user,
        )
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc
