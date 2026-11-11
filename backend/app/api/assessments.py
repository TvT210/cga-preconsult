"""评估会话：创建、逐题作答、断点续填、计分判读与医护复核。"""

from __future__ import annotations

import datetime as dt

from fastapi import Depends, HTTPException
from sqlalchemy.orm import Session

from app.api import new_router, paginate

router = new_router()
from app.core.deps import ROLE_ELDER, ensure_patient_access, get_current_user, require_staff
from app.db.base import get_db
from app.db.models import AssessmentAnswer, AssessmentScore, AssessmentSession, Patient, User
from app.services import audit
from app.services.branch_dispatch import (
    STATUS_SKIPPED,
    dispatch_branches,
    dispatch_overview,
    dispatch_source,
    dispatch_task,
)
from app.services.scale_presenter import present_questions, present_sections
from app.services.scales_store import get_scale
from app.services.scoring import (
    AnswerRecord,
    branch_recommendations,
    evaluate_scale,
    question_applies,
)


def _questions(scale: dict) -> list[dict]:
    items: list[dict] = []
    for section in scale.get("sections", []):
        for question in section.get("questions", []):
            items.append(question)
    return items


def _question_table(scale: dict) -> dict[str, dict]:
    return {question.get("code", ""): question for question in _questions(scale)}


def _next_question(scale: dict, answers: dict[str, AnswerRecord]) -> str:
    """下一道需要作答的题：跳过已作答的，也跳过当前条件下不适用的。

    不适用的判定与计分侧同源（`question_applies`），题目顺序保证分流题在前，
    因此这里按顺序取第一个「未作答且适用」的题即可。
    """
    answered = {code for code, record in answers.items() if record.present or record.skipped}
    for question in _questions(scale):
        code = question.get("code", "")
        if code in answered:
            continue
        if not question_applies(question, answers):
            continue
        return code
    return ""


def _answer_records(db: Session, session_id: int) -> dict[str, AnswerRecord]:
    records: dict[str, AnswerRecord] = {}
    for row in db.query(AssessmentAnswer).filter(AssessmentAnswer.session_id == session_id).all():
        records[row.question_code] = AnswerRecord(
            value=row.value,
            score=row.score,
            measured=row.measured,
            skipped=row.skipped,
            skip_reason=row.skip_reason,
            proxy_flag=row.proxy_flag,
            answered_by=row.answered_by,
        )
    return records


def _session_payload(db: Session, session: AssessmentSession, include_questions: bool = True) -> dict:
    scale = get_scale(db, session.scale_code) or {}
    questions = _questions(scale)
    answers = _answer_records(db, session.id)
    next_question = _next_question(scale, answers)
    payload = {
        "id": session.id,
        "patient_id": session.patient_id,
        "scale_code": session.scale_code,
        "scale_name": scale.get("name", session.scale_code),
        "dimension": scale.get("dimension", ""),
        "status": session.status,
        "mode": session.mode,
        "proxy": {
            "is_proxy": bool(session.proxy_name),
            "proxy_name": session.proxy_name,
            "proxy_relation": session.proxy_relation,
        },
        "progress": session.progress,
        "total_questions": len(questions),
        "current_question": next_question,
        # 派发溯源（A-3）：本任务由哪次评估的哪条分支触发，以及本次评估又派生了哪些任务。
        # 老人端结果页与医护复核页共用这两个字段，避免两处各算一遍。
        "dispatched_from": dispatch_source(db, session),
        "dispatched": dispatch_overview(db, session.id),
        "scale_version": session.scale_version,
        "rule_version": session.rule_version,
        "started_at": session.started_at.isoformat() if session.started_at else "",
        "finished_at": session.finished_at.isoformat() if session.finished_at else "",
        "answers": [
            {
                "question_code": code,
                "value": record.value,
                "score": record.score,
                # 实测原始值：断点续填时前端要能还原秒数/词语数，不能只拿归档档位
                "measured": record.measured,
                "skipped": record.skipped,
                "proxy_flag": record.proxy_flag,
                "answered_by": record.answered_by,
            }
            for code, record in answers.items()
        ],
    }
    if include_questions:
        # 表示层展开：与 GET /scales/{code} 保持同一套字段，避免两处不一致
        payload["questions"] = present_questions(questions)
        payload["sections"] = present_sections(scale.get("sections", []))
        payload["collection"] = scale.get("collection", {})
    return payload


@router.post("/assessments")
def create_assessment(
    payload: dict,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    patient_id = int(payload.get("patient_id") or 0)
    scale_code = (payload.get("scale_code") or "").strip()
    if not patient_id or not scale_code:
        raise HTTPException(status_code=400, detail="缺少 patient_id 或 scale_code")
    ensure_patient_access(user, patient_id)
    patient = db.get(Patient, patient_id)
    if patient is None:
        raise HTTPException(status_code=404, detail="患者不存在")
    scale = get_scale(db, scale_code)
    if scale is None:
        raise HTTPException(status_code=404, detail="量表不存在")
    if not _questions(scale):
        raise HTTPException(status_code=400, detail="该量表条目待以标准原文补录，暂不可采集")

    mode = payload.get("mode") or ("patient" if user.role == ROLE_ELDER else "staff")

    # 断点续填：同一患者 + 同一量表存在进行中的会话则继续
    existing = (
        db.query(AssessmentSession)
        .filter(
            AssessmentSession.patient_id == patient_id,
            AssessmentSession.scale_code == scale_code,
            AssessmentSession.status == "in_progress",
        )
        .order_by(AssessmentSession.id.desc())
        .first()
    )
    if existing is not None:
        return _session_payload(db, existing)

    session = AssessmentSession(
        patient_id=patient_id,
        scale_code=scale_code,
        scale_version=scale.get("version", "0.1.0-draft"),
        rule_version=scale.get("version", "0.1.0-draft"),
        status="in_progress",
        mode=mode,
        proxy_name=payload.get("proxy_name", "") or "",
        proxy_relation=payload.get("proxy_relation", "") or "",
        created_by=user.id,
    )
    db.add(session)
    db.commit()
    db.refresh(session)
    audit.record(db, user, "create", "assessment", session.id, {"patient_id": patient_id, "scale_code": scale_code})
    db.commit()
    return _session_payload(db, session)


@router.post("/assessments/dispatch")
def manual_dispatch(
    payload: dict,
    user: User = Depends(require_staff),
    db: Session = Depends(get_db),
):
    """医护手动派发一张量表给患者（A-3 遗留项：staff 端派发入口）。

    与自动派发只建同一种空壳任务：不代填、不下结论，患者仍需自己进入作答。
    与自动派发的差别是**不做环形防护**——医护明确要求补测/复测是合法决策，
    系统的环防护只用于约束机器自行派生。派发人、理由与来源评估都会落库以便追溯。
    """
    patient_id = int(payload.get("patient_id") or 0)
    scale_code = (payload.get("scale_code") or "").strip()
    if not patient_id or not scale_code:
        raise HTTPException(status_code=400, detail="缺少 patient_id 或 scale_code")

    patient = db.get(Patient, patient_id)
    if patient is None:
        raise HTTPException(status_code=404, detail="患者不存在")

    source: AssessmentSession | None = None
    source_id = payload.get("source_session_id")
    if source_id not in (None, ""):
        source = db.get(AssessmentSession, int(source_id))
        if source is None:
            raise HTTPException(status_code=404, detail="来源评估不存在")
        if source.patient_id != patient_id:
            raise HTTPException(status_code=400, detail="来源评估与该患者不一致")

    entry = dispatch_task(
        db,
        user,
        patient_id,
        scale_code,
        reason=(payload.get("reason") or "").strip(),
        source=source,
        branch_code=(payload.get("branch_code") or "").strip(),
    )
    db.commit()
    audit.record(
        db,
        user,
        "dispatch",
        "assessment",
        entry["session_id"] or "",
        {
            "patient_id": patient_id,
            "scale_code": scale_code,
            "status": entry["status"],
            "skip_reason": entry["skip_reason"],
            "source_session_id": source.id if source is not None else None,
        },
    )
    db.commit()
    if entry["status"] == STATUS_SKIPPED:
        # 不抛 4xx：前端需要按 skip_reason 给出「该量表条目待补录」这类具体解释
        entry["message"] = {
            "scale_missing": "题库中没有这张量表",
            "no_questions": "该量表条目待以标准原文补录，暂不可采集",
        }.get(entry["skip_reason"], "暂无法派发该量表")
    return entry


@router.get("/assessments")
def list_assessments(
    patient_id: int = 0,
    scale_code: str = "",
    status: str = "",
    page: int = 1,
    size: int = 20,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    query = db.query(AssessmentSession)
    if user.role == ROLE_ELDER:
        # 老人只能看到本人数据；未绑定患者时返回空集
        query = query.filter(AssessmentSession.patient_id == (user.patient_id if user.patient_id is not None else -1))
    if patient_id:
        ensure_patient_access(user, patient_id)
        query = query.filter(AssessmentSession.patient_id == patient_id)
    if scale_code:
        query = query.filter(AssessmentSession.scale_code == scale_code)
    if status:
        query = query.filter(AssessmentSession.status == status)
    rows = query.order_by(AssessmentSession.id.desc()).all()
    items = [
        {
            "id": row.id,
            "patient_id": row.patient_id,
            "scale_code": row.scale_code,
            "status": row.status,
            "mode": row.mode,
            "progress": row.progress,
            "started_at": row.started_at.isoformat() if row.started_at else "",
            "finished_at": row.finished_at.isoformat() if row.finished_at else "",
        }
        for row in rows
    ]
    return paginate(items, page, size)


@router.get("/patients/{patient_id}/assessments")
def list_patient_assessments(
    patient_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ensure_patient_access(user, patient_id)
    rows = (
        db.query(AssessmentSession)
        .filter(AssessmentSession.patient_id == patient_id)
        .order_by(AssessmentSession.id.desc())
        .all()
    )
    scores = {
        score.session_id: score
        for score in db.query(AssessmentScore).filter(AssessmentScore.patient_id == patient_id).all()
    }
    items = []
    for row in rows:
        score = scores.get(row.id)
        items.append(
            {
                "id": row.id,
                "scale_code": row.scale_code,
                "status": row.status,
                "mode": row.mode,
                "progress": row.progress,
                "score": {
                    "total": score.total,
                    "level": score.level,
                    "interpretation": score.interpretation,
                    "abnormal": score.abnormal,
                    "severity": score.severity,
                    "needs_manual_review": score.needs_manual_review,
                }
                if score
                else None,
                "started_at": row.started_at.isoformat() if row.started_at else "",
                "finished_at": row.finished_at.isoformat() if row.finished_at else "",
            }
        )
    return {"items": items, "total": len(items)}


@router.get("/assessments/{session_id}")
def get_assessment(
    session_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    session = db.get(AssessmentSession, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="评估任务不存在")
    ensure_patient_access(user, session.patient_id)
    payload = _session_payload(db, session)
    score = db.query(AssessmentScore).filter(AssessmentScore.session_id == session_id).first()
    if score:
        payload["score"] = {
            "total": score.total,
            "level": score.level,
            "interpretation": score.interpretation,
            "abnormal": score.abnormal,
            "severity": score.severity,
            "flags": score.flags,
            "explanation": score.explanation,
            "rule_refs": score.rule_refs,
            "missing_items": score.missing_items,
            "needs_manual_review": score.needs_manual_review,
        }
    return payload


def _band_for(measured: float, options: list[dict]) -> dict | None:
    """按实测值匹配分档选项：用于 SPPB 步速/起坐、洼田饮水时间等实测项。"""
    for option in options:
        low = option.get("min")
        high = option.get("max")
        if low is None and high is None:
            continue
        if (low is None or measured >= float(low)) and (high is None or measured <= float(high)):
            return option
    return None


def _apply_answer(
    db: Session,
    session: AssessmentSession,
    question_code: str,
    value,
    measured,
    proxy_flag: bool,
    answered_by: str,
) -> AssessmentAnswer:
    scale = get_scale(db, session.scale_code) or {}
    table = _question_table(scale)
    question = table.get(question_code)
    if question is None:
        raise HTTPException(status_code=404, detail=f"题目 {question_code} 不存在")

    score: float | None = None
    stored_value = ""
    input_type = question.get("input_type", "single")
    if input_type in {"single", "multi"}:
        options = question.get("options", []) or []
        # 实测分档题：只提交实测值时按区间自动定档，避免把秒数当分值
        if (
            input_type == "single"
            and (value is None or value == "")
            and measured is not None
            and any(opt.get("min") is not None or opt.get("max") is not None for opt in options)
        ):
            try:
                band = _band_for(float(measured), options)
            except (TypeError, ValueError):
                band = None
            if band is None:
                raise HTTPException(status_code=422, detail="实测值不在任何分档区间内，请核对或交由医护人员判定")
            value = band.get("value")
        if input_type == "multi":
            values = value if isinstance(value, list) else [value]
            chosen = [opt for opt in options if opt.get("value") in values]
            if not chosen:
                raise HTTPException(status_code=400, detail="选项无效")
            score = sum(float(opt.get("score", 0) or 0) for opt in chosen)
            stored_value = ",".join(str(opt.get("value")) for opt in chosen)
        else:
            chosen = next((opt for opt in options if str(opt.get("value")) == str(value)), None)
            if chosen is None:
                raise HTTPException(status_code=400, detail="选项无效")
            score = float(chosen.get("score", 0) or 0)
            stored_value = str(chosen.get("value"))
    else:  # number / measured
        raw = measured if measured is not None else value
        try:
            score = float(raw)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="数值无效")
        stored_value = str(raw)

    answer = (
        db.query(AssessmentAnswer)
        .filter(AssessmentAnswer.session_id == session.id, AssessmentAnswer.question_code == question_code)
        .first()
    )
    if answer is None:
        answer = AssessmentAnswer(session_id=session.id, question_code=question_code)
        db.add(answer)
    answer.value = stored_value
    answer.score = score
    answer.measured = float(measured) if measured is not None else None
    answer.skipped = False
    answer.skip_reason = ""
    answer.proxy_flag = proxy_flag or bool(session.proxy_name)
    answer.answered_by = answered_by or session.proxy_name or ""
    answer.answered_at = dt.datetime.now(dt.timezone.utc)

    total = len(_questions(scale))
    db.flush()
    answered = (
        db.query(AssessmentAnswer)
        .filter(AssessmentAnswer.session_id == session.id, AssessmentAnswer.skipped.is_(False))
        .count()
    )
    session.progress = answered
    session.current_question = question_code
    return answer


@router.post("/assessments/{session_id}/answers")
def submit_answer(
    session_id: int,
    payload: dict,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    session = db.get(AssessmentSession, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="评估任务不存在")
    ensure_patient_access(user, session.patient_id)
    if session.status != "in_progress":
        raise HTTPException(status_code=400, detail="该任务已结束，无法继续作答")

    question_code = (payload.get("question_code") or "").strip()
    if not question_code:
        raise HTTPException(status_code=400, detail="缺少 question_code")
    answer = _apply_answer(
        db,
        session,
        question_code,
        payload.get("value"),
        payload.get("measured"),
        bool(payload.get("proxy_flag")),
        payload.get("answered_by", ""),
    )
    db.commit()

    scale = get_scale(db, session.scale_code) or {}
    questions = _questions(scale)
    next_question = _next_question(scale, _answer_records(db, session.id))
    session.current_question = next_question
    db.commit()
    return {
        "answer": {
            "question_code": answer.question_code,
            "value": answer.value,
            "score": answer.score,
            "proxy_flag": answer.proxy_flag,
            "answered_by": answer.answered_by,
        },
        "next_question": next_question,
        "progress": session.progress,
        "total_questions": len(questions),
    }


@router.post("/assessments/{session_id}/skip")
def skip_question(
    session_id: int,
    payload: dict,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    session = db.get(AssessmentSession, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="评估任务不存在")
    ensure_patient_access(user, session.patient_id)
    question_code = (payload.get("question_code") or "").strip()
    answer = (
        db.query(AssessmentAnswer)
        .filter(AssessmentAnswer.session_id == session.id, AssessmentAnswer.question_code == question_code)
        .first()
    )
    if answer is None:
        answer = AssessmentAnswer(session_id=session.id, question_code=question_code)
        db.add(answer)
    answer.value = ""
    answer.score = None
    answer.skipped = True
    answer.skip_reason = payload.get("reason", "")
    db.commit()
    return {"question_code": question_code, "skipped": True, "progress": session.progress}


def _score_and_store(db: Session, session: AssessmentSession) -> tuple[AssessmentScore, list[dict]]:
    scale = get_scale(db, session.scale_code) or {}
    answers = _answer_records(db, session.id)
    evaluation = evaluate_scale(scale, answers)
    branches = branch_recommendations(scale, answers)

    score = (
        db.query(AssessmentScore)
        .filter(AssessmentScore.session_id == session.id)
        .first()
    )
    if score is None:
        score = AssessmentScore(session_id=session.id, patient_id=session.patient_id)
        db.add(score)
    score.scale_code = session.scale_code
    score.scale_version = session.scale_version
    score.rule_version = session.rule_version
    score.total = evaluation.total
    score.level = evaluation.level
    score.interpretation = evaluation.interpretation
    score.abnormal = evaluation.abnormal
    score.severity = evaluation.severity
    score.flags = evaluation.flags
    score.explanation = evaluation.explanation
    score.rule_refs = evaluation.rule_refs
    score.missing_items = evaluation.missing_items
    score.needs_manual_review = evaluation.needs_manual_review
    db.commit()
    db.refresh(score)
    return score, branches


@router.post("/assessments/{session_id}/finish")
def finish_assessment(
    session_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    session = db.get(AssessmentSession, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="评估任务不存在")
    ensure_patient_access(user, session.patient_id)
    score, branches = _score_and_store(db, session)
    session.status = "finished"
    session.finished_at = dt.datetime.now(dt.timezone.utc)
    db.commit()
    # 筛查阳性 → 为患者派生待办任务（只建任务，不代填、不下结论）
    dispatched = dispatch_branches(db, user, session, branches)
    db.commit()
    audit.record(
        db,
        user,
        "finish",
        "assessment",
        session.id,
        {
            "total": score.total,
            "level": score.level,
            "dispatched": sum(1 for item in dispatched if item["status"] == "dispatched"),
        },
    )
    db.commit()
    return {
        "scores": [
            {
                "scale_code": score.scale_code,
                "total": score.total,
                "level": score.level,
                "interpretation": score.interpretation,
                "abnormal": score.abnormal,
                "severity": score.severity,
                "flags": score.flags,
                "explanation": score.explanation,
                "rule_refs": score.rule_refs,
                "missing_items": score.missing_items,
                "needs_manual_review": score.needs_manual_review,
            }
        ],
        "branches": branches,
        "dispatched": dispatched,
        "needs_manual_review": score.needs_manual_review,
        "notices": [
            "题库条目待评审，结论仅供演示，不作为正式临床结论。"
            if score.needs_manual_review
            else ""
        ],
    }
