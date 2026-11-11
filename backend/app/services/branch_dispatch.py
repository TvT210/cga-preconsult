"""分支跳转自动派发（A-3）。

筛查阳性 → 为目标量表创建一条**待办任务**，由患者/医护自行进入评估。

设计约束（务必保持）：

1. **只派任务，不代填、不下结论。** 派发出来的会话是 `in_progress` 空壳，
   与患者手动新建的任务完全等价；系统不会替患者作答，也不会因分支触发就生成结论。
2. **环形防护。** 题库 21 张量表共 28 条分支边，其中存在大量环
   （B.1→B.3→B.1、B.4↔B.5、B.6↔B.7、B.14↔B.15、B.8↔B.21、B.19↔B.18 等）。
   若不做防护，一次阳性会无限派生任务。此处沿 `dispatched_from_id` 回溯本次评估链，
   链上出现过的量表不再派发。
3. **幂等。** 同一会话重复调用（如重复 finish）不会重复创建任务，直接返回首次结果。
4. **去重。** 患者已有该量表的进行中任务时复用，不新建。
5. **不派空量表。** 条目尚未按标准原文补录的量表不可采集，跳过并说明原因。

人工派发（`dispatch_task`）与自动派发共用建任务逻辑，但**不做环形防护**：
环防护的目的是防止机器无限自派生，医护人员主动要求"再做一次某量表"是合法临床决策
（复测、补测、漏项重采），系统不应拒绝，只记录派发人与理由以便追溯。
"""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.db.models import AssessmentSession, User
from app.services.scales_store import get_scale

MAX_CHAIN_DEPTH = 12
"""评估链回溯上限。正常临床路径远小于此值，仅用于兜住历史脏数据。"""

DEFAULT_SCALE_VERSION = "0.1.0-draft"

STATUS_DISPATCHED = "dispatched"
STATUS_REUSED = "reused"
STATUS_SKIPPED = "skipped"


def chain_scale_codes(db: Session, session: AssessmentSession) -> set[str]:
    """本次评估链上已出现过的量表编码（含起点自身）。"""
    codes: set[str] = set()
    visited: set[int] = set()
    current: AssessmentSession | None = session
    for _ in range(MAX_CHAIN_DEPTH + 1):
        if current is None or current.id in visited:
            break
        visited.add(current.id)
        codes.add(current.scale_code)
        parent_id = current.dispatched_from_id
        current = db.get(AssessmentSession, parent_id) if parent_id else None
    return codes


def _has_questions(scale: dict) -> bool:
    return any(section.get("questions") for section in scale.get("sections") or [])


def _entry(branch: dict, source_scale: str) -> dict:
    # branch_recommendations 输出 branch_code，题库原始定义里叫 code，两处都认
    return {
        "branch_code": branch.get("branch_code") or branch.get("code", "") or "",
        "source_scale": branch.get("source_scale") or source_scale,
        "target_scale": branch.get("target_scale", "") or "",
        "target_name": "",
        "reason": branch.get("reason", "") or "",
        "status": STATUS_SKIPPED,
        "skip_reason": "",
        "session_id": None,
        "session_status": "",
    }


def _existing_in_progress(
    db: Session, patient_id: int, scale_code: str
) -> AssessmentSession | None:
    return (
        db.query(AssessmentSession)
        .filter(
            AssessmentSession.patient_id == patient_id,
            AssessmentSession.scale_code == scale_code,
            AssessmentSession.status == "in_progress",
        )
        .order_by(AssessmentSession.id.desc())
        .first()
    )


def _dispatched_children(db: Session, session_id: int) -> dict[str, AssessmentSession]:
    rows = (
        db.query(AssessmentSession)
        .filter(AssessmentSession.dispatched_from_id == session_id)
        .order_by(AssessmentSession.id.asc())
        .all()
    )
    return {row.dispatch_branch_code: row for row in rows if row.dispatch_branch_code}


def _new_task(
    db: Session,
    user: User | None,
    patient_id: int,
    target_scale: str,
    *,
    version: str,
    mode: str,
    proxy_name: str,
    proxy_relation: str,
    source: AssessmentSession | None,
    branch_code: str,
    reason: str,
) -> AssessmentSession:
    """建一条 `in_progress` 待办任务。只建空壳，不写任何作答或结论。"""
    child = AssessmentSession(
        patient_id=patient_id,
        scale_code=target_scale,
        scale_version=version,
        rule_version=version,
        status="in_progress",
        mode=mode,
        proxy_name=proxy_name,
        proxy_relation=proxy_relation,
        created_by=user.id if user is not None else None,
        dispatched_from_id=source.id if source is not None else None,
        dispatch_branch_code=branch_code,
        dispatch_reason=reason,
    )
    db.add(child)
    db.flush()
    return child


def _describe(child: AssessmentSession) -> dict:
    """把待办任务会话转成前端可直接展示的概览条目。"""
    return {
        "session_id": child.id,
        "target_scale": child.scale_code,
        "branch_code": child.dispatch_branch_code or "",
        "reason": child.dispatch_reason or "",
        "status": child.status,
        "progress": child.progress,
        "created_at": child.started_at.isoformat() if child.started_at else "",
        "finished_at": child.finished_at.isoformat() if child.finished_at else "",
    }


def dispatch_overview(db: Session, session_id: int) -> list[dict]:
    """本次评估派生出的后续任务（含已完成的），供老人端与医护端展示派发结果。"""
    rows = (
        db.query(AssessmentSession)
        .filter(AssessmentSession.dispatched_from_id == session_id)
        .order_by(AssessmentSession.id.asc())
        .all()
    )
    items: list[dict] = []
    for row in rows:
        scale = get_scale(db, row.scale_code) or {}
        item = _describe(row)
        item["target_name"] = scale.get("name", "") or row.scale_code
        items.append(item)
    return items


def dispatch_source(db: Session, session: AssessmentSession) -> dict | None:
    """本任务由哪次评估、哪条分支触发；非派发产生的任务返回 None。"""
    if not session.dispatched_from_id:
        return None
    parent = db.get(AssessmentSession, session.dispatched_from_id)
    if parent is None:
        return None
    parent_scale = get_scale(db, parent.scale_code) or {}
    return {
        "session_id": parent.id,
        "scale_code": parent.scale_code,
        "scale_name": parent_scale.get("name", "") or parent.scale_code,
        "branch_code": session.dispatch_branch_code or "",
        "reason": session.dispatch_reason or "",
    }


def dispatch_task(
    db: Session,
    user: User | None,
    patient_id: int,
    target_scale: str,
    *,
    reason: str = "",
    source: AssessmentSession | None = None,
    branch_code: str = "",
) -> dict:
    """人工派发：医护指定一张量表给患者，建立待办任务。

    与自动派发的区别只有一点——**不做环形防护**（见模块说明）。
    去重逻辑保持一致：患者已有该量表的进行中任务时复用，避免重复建壳。
    不提交事务，由调用方统一 commit。
    """
    entry = {
        "branch_code": branch_code,
        "source_scale": source.scale_code if source is not None else "",
        "target_scale": target_scale or "",
        "target_name": "",
        "reason": reason,
        "status": STATUS_SKIPPED,
        "skip_reason": "",
        "session_id": None,
        "session_status": "",
    }
    if not target_scale:
        entry["skip_reason"] = "scale_missing"
        return entry

    scale = get_scale(db, target_scale)
    if scale is None:
        entry["skip_reason"] = "scale_missing"
        return entry
    entry["target_name"] = scale.get("name", "") or ""
    if not _has_questions(scale):
        entry["skip_reason"] = "no_questions"
        return entry

    ongoing = _existing_in_progress(db, patient_id, target_scale)
    if ongoing is not None:
        entry["status"] = STATUS_REUSED
        entry["session_id"] = ongoing.id
        entry["session_status"] = ongoing.status
        return entry

    child = _new_task(
        db,
        user,
        patient_id,
        target_scale,
        version=scale.get("version") or DEFAULT_SCALE_VERSION,
        mode=source.mode if source is not None else "staff",
        proxy_name=source.proxy_name if source is not None else "",
        proxy_relation=source.proxy_relation if source is not None else "",
        source=source,
        branch_code=branch_code,
        reason=reason,
    )
    entry["status"] = STATUS_DISPATCHED
    entry["session_id"] = child.id
    entry["session_status"] = child.status
    return entry


def dispatch_branches(
    db: Session,
    user: User | None,
    session: AssessmentSession,
    branches: list[dict],
) -> list[dict]:
    """按触发的分支为患者派生待办任务，返回逐条派发结果。

    不提交事务，由调用方统一 commit。
    """
    results: list[dict] = []
    if not branches:
        return results

    chain = chain_scale_codes(db, session)
    already = _dispatched_children(db, session.id)
    planned: set[str] = set()

    for branch in branches:
        entry = _entry(branch, session.scale_code)
        target = entry["target_scale"]
        branch_code = entry["branch_code"]

        # 幂等：本次会话此前已为该分支派发过，直接回报既有任务
        previous = already.get(branch_code) if branch_code else None
        if previous is not None:
            entry["status"] = STATUS_REUSED
            entry["session_id"] = previous.id
            entry["session_status"] = previous.status
            results.append(entry)
            planned.add(target)
            continue

        # 环形防护：目标量表已在本次链上（含起点），不再派生
        if target in chain:
            entry["skip_reason"] = "cycle"
            results.append(entry)
            continue

        # 同一批分支重复指向同一量表，只派一次
        if target in planned:
            entry["skip_reason"] = "duplicate"
            results.append(entry)
            continue

        if not target:
            entry["skip_reason"] = "scale_missing"
            results.append(entry)
            continue

        scale = get_scale(db, target)
        if scale is None:
            entry["skip_reason"] = "scale_missing"
            results.append(entry)
            continue
        entry["target_name"] = scale.get("name", "") or ""
        if not _has_questions(scale):
            entry["skip_reason"] = "no_questions"
            results.append(entry)
            continue

        ongoing = _existing_in_progress(db, session.patient_id, target)
        if ongoing is not None:
            entry["status"] = STATUS_REUSED
            entry["session_id"] = ongoing.id
            entry["session_status"] = ongoing.status
            results.append(entry)
            planned.add(target)
            continue

        version = scale.get("version") or DEFAULT_SCALE_VERSION
        child = _new_task(
            db,
            user,
            session.patient_id,
            target,
            version=version,
            mode=session.mode,
            proxy_name=session.proxy_name,
            proxy_relation=session.proxy_relation,
            source=session,
            branch_code=branch_code,
            reason=entry["reason"],
        )

        entry["status"] = STATUS_DISPATCHED
        entry["session_id"] = child.id
        entry["session_status"] = child.status
        planned.add(target)
        results.append(entry)

    return results
