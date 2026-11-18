"""量表评审落库：签字人、凭据类型与录入人分开记。

做这层的起因很具体：原实现嘴上说「评审人是谁」，实际记的是**点按钮的人**。
外部临床专家没有系统账号，代录之后 `reviewer` 就变成了同事的名字——
这不是格式问题，是把没有发生的事记成了发生过的。

所以这里把三件事拆开：

- `reviewer`      谁签的字（人，可能不在系统里）；
- `evidence_type` 凭什么签（签字件 / 口头确认 / 系统内点击）；
- `operator`      谁把这条记录录进系统。

`approved` 与「已签字」**不是一回事**：口头确认也足以让题库进入可用状态，
但判读侧仍会保留一条凭据提示（见 `scoring.evaluate_scale`），
不把口头确认伪装成书面签字。
"""

from __future__ import annotations

import datetime as dt
from typing import Any

from sqlalchemy.orm import Session

from app.db.models import ScaleTemplate, TemplateApproval, User
from app.services import audit

#: 凭据类型 → 展示名。**顺序即可信度**，供前端排序与展示使用。
EVIDENCE_TYPES: dict[str, str] = {
    "signed_document": "签字件（纸质/扫描）",
    "in_system": "系统内审批（本人账号）",
    "verbal_confirmation": "口头/线上确认",
}

#: 无签字件时，审批记录必须写清依据，避免只留一个状态变更。
EVIDENCE_NEEDS_COMMENT = {"verbal_confirmation"}

#: 签字日期未知时允许留空，但会在记录里显式标注「日期未注明」。
_UNKNOWN_DATE_NOTE = "签字日期未注明，以录入时间为准"


def normalize_evidence(value: str | None) -> str:
    return (value or "").strip()


def evidence_label(value: str | None) -> str:
    return EVIDENCE_TYPES.get(normalize_evidence(value), "凭据未记录")


def parse_reviewed_at(value: Any) -> dt.datetime | None:
    """接受 `YYYY-MM-DD` 或 ISO 时间串；空值返回 None。"""
    if value in (None, ""):
        return None
    if isinstance(value, dt.datetime):
        return value
    text = str(value).strip()
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S"):
        try:
            return dt.datetime.strptime(text, fmt)
        except ValueError:
            continue
    try:
        parsed = dt.datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"签字日期格式无法识别：{text}") from exc
    if parsed.tzinfo is not None:
        # 库里存的是不带时区的 UTC，带偏移的输入先换算再丢时区，
        # 否则「2026-11-18T09:00+08:00」会被当成 09:00 UTC 存下来。
        parsed = parsed.astimezone(dt.timezone.utc).replace(tzinfo=None)
    return parsed


def _actor_name(user: User | None) -> str:
    if user is None:
        return ""
    return (user.full_name or user.username or "").strip()


def _latest_approval(db: Session, code: str) -> TemplateApproval | None:
    return (
        db.query(TemplateApproval)
        .filter(TemplateApproval.target_type == "scale", TemplateApproval.target_id == code)
        .order_by(TemplateApproval.id.desc())
        .first()
    )


def validate_evidence(
    *,
    reviewer_name: str | None,
    reviewer_title: str | None,
    evidence_type: str | None,
    comment: str | None,
    reviewed_at: Any,
    actor: User | None,
    require_title: bool = False,
    require_date: bool = False,
) -> dict:
    """校验并规范化一条审批凭据。

    量表评审与文案回写都走这里：两处对「谁签的、凭什么签」的要求必须一致，
    否则同一个口头确认，在量表上被拦下、在文案上却放行。
    """
    evidence = normalize_evidence(evidence_type)
    if evidence not in EVIDENCE_TYPES:
        raise ValueError(
            f"凭据类型必须是 {sorted(EVIDENCE_TYPES)} 之一（签字件 / 系统内审批 / 口头确认）"
        )

    name = (reviewer_name or "").strip()
    title = (reviewer_title or "").strip()
    note = (comment or "").strip()

    if evidence == "in_system":
        # 本人账号操作时签字人可以留空，落库时用当前账号名补齐。
        name = name or _actor_name(actor)
    if not name:
        raise ValueError("请填写签字人姓名：无法确认是谁评审的，这条记录不能落库")
    if evidence in EVIDENCE_NEEDS_COMMENT and not note:
        raise ValueError("口头/线上确认没有签字件，必须写明依据（何时、由谁、以何方式确认）")
    if require_title and not title:
        raise ValueError("请填写签字人职称或科室，便于事后追溯")

    signed_at = parse_reviewed_at(reviewed_at)
    if require_date and signed_at is None:
        raise ValueError("请填写签字日期")
    return {
        "reviewer_name": name,
        "reviewer_title": title,
        "evidence": evidence,
        "comment": note,
        "reviewed_at": signed_at,
    }


def review_payload(row: ScaleTemplate, approval: TemplateApproval | None = None) -> dict:
    """量表的评审态（给前端与判读层共用）。"""
    evidence = (row.review_evidence or "").strip()
    if not evidence and approval is not None:
        # 旧库补列后 review_evidence 为空，从最近一条审批记录回推，避免显示空白。
        evidence = (approval.evidence_type or "").strip()
    reviewed_at = row.reviewed_at or (approval.reviewed_at if approval else None)
    return {
        "review_status": row.review_status,
        "reviewer_name": (row.reviewer_name or (approval.reviewer if approval else "") or ""),
        "reviewer_title": (row.reviewer_title or (approval.reviewer_title if approval else "") or ""),
        "review_evidence": evidence,
        "review_evidence_label": evidence_label(evidence),
        "reviewed_at": reviewed_at.isoformat() if reviewed_at else "",
        "has_signed_document": evidence == "signed_document",
    }


def apply_review(
    db: Session,
    *,
    code: str,
    status: str,
    reviewer_name: str,
    reviewer_title: str,
    evidence_type: str,
    comment: str,
    reviewed_at: Any,
    actor: User | None,
) -> dict:
    """单张量表落评审。

    返回 `{code, result, reason, review}`，`result` ∈ applied / unchanged。
    校验失败抛 `ValueError`，由调用方转成 400。
    """
    row = db.query(ScaleTemplate).filter(ScaleTemplate.code == code).first()
    if row is None:
        raise ValueError(f"量表不存在：{code}")

    approved = status == "approved"
    signed = validate_evidence(
        reviewer_name=reviewer_name,
        reviewer_title=reviewer_title,
        evidence_type=evidence_type,
        comment=comment,
        reviewed_at=reviewed_at,
        actor=actor,
        require_title=approved,
        require_date=approved,
    )
    evidence = signed["evidence"]
    name = signed["reviewer_name"]
    title = signed["reviewer_title"]
    note = signed["comment"]
    signed_at = signed["reviewed_at"]

    approval = _latest_approval(db, code)
    same = (
        row.review_status == status
        and (row.review_evidence or "") == evidence
        and (row.reviewer_name or "") == name
        and (row.reviewer_title or "") == title
        and row.reviewed_at == signed_at
        and approval is not None
        and (approval.comment or "") == note
    )
    if same:
        # 批量重跑不应堆出一串同样的审批记录。
        return {"code": code, "result": "unchanged", "reason": "评审信息未变化", "review": review_payload(row, approval)}

    before = row.review_status
    row.review_status = status
    row.reviewer_name = name
    row.reviewer_title = title
    row.review_evidence = evidence
    row.reviewed_at = signed_at

    record = TemplateApproval(
        target_type="scale",
        target_id=code,
        action=status,
        reviewer=name,
        reviewer_title=title,
        evidence_type=evidence,
        operator=_actor_name(actor),
        reviewed_at=signed_at,
        comment=note or (_UNKNOWN_DATE_NOTE if signed_at is None else ""),
    )
    db.add(record)
    db.flush()
    audit.record(
        db,
        actor,
        "review",
        "scale",
        code,
        {
            "from": before,
            "to": status,
            "reviewer": name,
            "reviewer_title": title,
            "evidence": evidence,
        },
    )
    return {"code": code, "result": "applied", "reason": "", "review": review_payload(row, record)}


def apply_batch(
    db: Session,
    *,
    codes: list[str],
    status: str,
    reviewer_name: str,
    reviewer_title: str,
    evidence_type: str,
    comment: str,
    reviewed_at: Any,
    actor: User | None,
) -> dict:
    """逐张落库，一张失败不影响其余，最后返回逐条结果。

    刻意不做「全有或全无」的事务：21 张里若 3 张已被别的批次改过，
    整体回滚会让人以为是权限问题，而实际只需要看到哪几张没成。
    """
    results: list[dict] = []
    applied = unchanged = 0
    for code in codes:
        try:
            item = apply_review(
                db,
                code=code,
                status=status,
                reviewer_name=reviewer_name,
                reviewer_title=reviewer_title,
                evidence_type=evidence_type,
                comment=comment,
                reviewed_at=reviewed_at,
                actor=actor,
            )
            results.append(item)
            if item["result"] == "applied":
                applied += 1
            else:
                unchanged += 1
        except ValueError as exc:
            results.append({"code": code, "result": "rejected", "reason": str(exc), "review": None})
    db.commit()
    return {
        "total": len(codes),
        "applied": applied,
        "unchanged": unchanged,
        "rejected": len(codes) - applied - unchanged,
        "evidence": evidence_type,
        "evidence_label": evidence_label(evidence_type),
        "items": results,
    }
