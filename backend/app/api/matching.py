"""疾病库与症状—疾病匹配提醒。"""

from __future__ import annotations

from fastapi import Depends, HTTPException
from sqlalchemy.orm import Session

from app.api import new_router

router = new_router()
from app.core.config import settings
from app.core.deps import ROLE_ADMIN, ROLE_DOCTOR, get_current_user, require_roles, require_staff
from app.db.base import get_db
from app.db.models import (
    Alert,
    AlertThreshold,
    AssessmentScore,
    MatchAiReview,
    MatchCandidate,
    MatchRun,
    MatchingRule,
    Patient,
    PatientMedicalProfile,
    Preconsult,
    User,
)
from app.services import audit
from app.services.ai_review import review_match
from app.services.disease_library import extract_preconsult_symptoms, list_diseases
from app.services.matching import DISCLAIMER, MatchingWeights, build_evidence, run_matching

RULE_VERSION = "0.1.0-draft"


def _weights(db: Session) -> MatchingWeights:
    weights = MatchingWeights(
        core=settings.core_symptom_weight,
        secondary=settings.secondary_symptom_weight,
        history_bonus=settings.history_bonus,
        temperature=settings.probability_temperature,
        global_threshold=settings.global_alert_threshold,
    )
    for rule in db.query(MatchingRule).all():
        if rule.key == "core_symptom_weight":
            weights.core = rule.value
        elif rule.key == "secondary_symptom_weight":
            weights.secondary = rule.value
        elif rule.key == "history_bonus":
            weights.history_bonus = rule.value
        elif rule.key == "probability_temperature":
            weights.temperature = rule.value
        elif rule.key == "global_alert_threshold":
            weights.global_threshold = rule.value
    return weights


def _thresholds(db: Session, weights: MatchingWeights) -> dict[str, float]:
    table: dict[str, float] = {}
    for row in db.query(AlertThreshold).all():
        if row.scope == "global":
            table["global"] = row.threshold
        elif row.disease_code:
            table[row.disease_code] = row.threshold
    table.setdefault("global", weights.global_threshold)
    return table


@router.get("/diseases")
def get_diseases(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    diseases = list_diseases(db)
    thresholds = [
        {
            "id": row.id,
            "scope": row.scope,
            "disease_code": row.disease_code,
            "threshold": row.threshold,
            "level": row.level,
            "review_status": row.review_status,
        }
        for row in db.query(AlertThreshold).order_by(AlertThreshold.id).all()
    ]
    return {
        "diseases": [
            {
                "code": item["code"],
                "name": item["name"],
                "aliases": item["aliases"],
                "system": item["system"],
                "risk_level": item["risk_level"],
                "review_status": item["review_status"],
                "symptom_count": item["symptom_count"],
            }
            for item in diseases
        ],
        "thresholds": thresholds,
        "disclaimer": DISCLAIMER,
    }


@router.get("/diseases/{code}")
def get_disease(code: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    for item in list_diseases(db):
        if item["code"] == code:
            payload = dict(item["payload"] or {})
            payload.update(
                {
                    "code": item["code"],
                    "name": item["name"],
                    "aliases": item["aliases"],
                    "system": item["system"],
                    "risk_level": item["risk_level"],
                    "review_status": item["review_status"],
                }
            )
            return payload
    raise HTTPException(status_code=404, detail="疾病不存在")


@router.post("/matching/run")
def create_match_run(
    request_body: dict,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """执行一次症状—疾病匹配，输出多候选与分级提醒。

    request_body.with_ai_review = true 时，额外执行一次 AI 语义复核（只给建议，不改结论）。
    """
    patient_id = int(request_body.get("patient_id") or 0)
    if not patient_id:
        raise HTTPException(status_code=400, detail="缺少 patient_id")
    patient = db.get(Patient, patient_id)
    if patient is None:
        raise HTTPException(status_code=404, detail="患者不存在")

    diseases = list_diseases(db)
    if not diseases:
        raise HTTPException(status_code=400, detail="疾病库为空，请先导入疾病库")

    scale_flags: list[dict] = []
    latest: dict[str, AssessmentScore] = {}
    for score in (
        db.query(AssessmentScore)
        .filter(AssessmentScore.patient_id == patient_id)
        .order_by(AssessmentScore.created_at.desc())
        .all()
    ):
        latest.setdefault(score.scale_code, score)
    for score in latest.values():
        for flag in score.flags or []:
            scale_flags.append(
                {
                    "code": flag.get("flag", ""),
                    "symptom_codes": flag.get("symptom_codes", []),
                    "source": "scale",
                }
            )

    profile = (
        db.query(PatientMedicalProfile).filter(PatientMedicalProfile.patient_id == patient_id).first()
    )
    dialogue_symptoms = (profile.symptoms if profile else []) or []

    conditions: list[str] = []
    preconsult_symptoms: list[dict] = []
    preconsult = db.query(Preconsult).filter(Preconsult.patient_id == patient_id).first()
    if preconsult:
        preconsult_payload = preconsult.payload or {}
        history = preconsult_payload.get("history") or {}
        conditions = list(history.get("conditions") or [])
        # 预问诊自述必须参与匹配（采集侧信息的主入口）
        preconsult_symptoms = extract_preconsult_symptoms(preconsult_payload)
    if profile and profile.conditions:
        conditions.extend(profile.conditions)

    extracted_symptoms = list(preconsult_symptoms) + list(dialogue_symptoms)
    evidence = build_evidence(scale_flags, extracted_symptoms, conditions)
    weights = _weights(db)
    thresholds = _thresholds(db, weights)
    outcome = run_matching(diseases, evidence, weights, thresholds)

    run = MatchRun(
        patient_id=patient_id,
        input_snapshot={
            "evidence": outcome.evidence,
            "scale_flags": scale_flags,
            "preconsult_symptoms": preconsult_symptoms,
            "dialogue_symptoms": dialogue_symptoms,
            "conditions": conditions,
        },
        thresholds=outcome.thresholds,
        rule_version=RULE_VERSION,
        created_by=user.id,
    )
    db.add(run)
    db.flush()

    for candidate in outcome.candidates:
        db.add(
            MatchCandidate(
                run_id=run.id,
                disease_code=candidate["disease_code"],
                disease_name=candidate["disease_name"],
                rank=candidate.get("rank", 0),
                match_score=candidate["match_score"],
                ref_probability=candidate["ref_probability"],
                raw_score=candidate.get("raw_score", 0),
                hit_symptoms=candidate["hit_symptoms"],
                missing_symptoms=candidate["missing_symptoms"],
                excluded_reasons=candidate["excluded_reasons"],
                red_flags=candidate.get("red_flags", []),
                protective_signs=candidate.get("protective_signs", []),
                risk_factor_hits=candidate.get("risk_factor_hits", []),
                pattern_hits=candidate.get("pattern_hits", []),
                distinctive_symptoms=candidate.get("distinctive_symptoms", []),
                shared_symptoms=candidate.get("shared_symptoms", []),
                risk_level=candidate.get("risk_level", "observe"),
                advice=candidate.get("advice", {}),
                evidence_insufficient=candidate.get("evidence_insufficient", False),
            )
        )

    alert = None
    if outcome.alert:
        alert = Alert(
            patient_id=patient_id,
            match_run_id=run.id,
            level=outcome.alert["level"],
            message=outcome.alert["message"],
            department=outcome.alert.get("department", ""),
            disclaimer=DISCLAIMER,
            status="pending",
        )
        db.add(alert)
    db.commit()
    db.refresh(run)
    audit.record(db, user, "run", "matching", run.id, {"patient_id": patient_id, "candidates": len(outcome.candidates)})
    db.commit()

    response = _run_payload(db, run)
    if bool(request_body.get("with_ai_review")):
        response["ai_review"] = _run_ai_review(db, run, user, patient)
    return response


def _run_ai_review(db: Session, run: MatchRun, user: User, patient: Patient) -> dict:
    """对一次匹配批次执行 AI 复核（不改分值、不改等级，只给建议）。"""
    rows = (
        db.query(MatchCandidate)
        .filter(MatchCandidate.run_id == run.id)
        .order_by(MatchCandidate.rank)
        .all()
    )
    candidates = [
        {
            "disease_code": row.disease_code,
            "disease_name": row.disease_name,
            "match_score": row.match_score,
            "ref_probability": row.ref_probability,
            "hit_symptoms": row.hit_symptoms,
            "missing_symptoms": row.missing_symptoms,
            "distinctive_symptoms": row.distinctive_symptoms,
            "shared_symptoms": row.shared_symptoms,
            "pattern_hits": row.pattern_hits,
            "red_flags": row.red_flags,
            "protective_signs": row.protective_signs,
            "risk_factor_hits": row.risk_factor_hits,
            "core_hits": sum(1 for item in (row.hit_symptoms or []) if item.get("weight") == "core"),
        }
        for row in rows
    ]
    profiles = {item["code"]: (item.get("payload") or {}) for item in list_diseases(db)}

    snapshot = run.input_snapshot or {}
    preconsult = db.query(Preconsult).filter(Preconsult.patient_id == run.patient_id).first()
    chief_complaint = ""
    history: list[str] = []
    if preconsult:
        payload_pc = preconsult.payload or {}
        chief_complaint = (payload_pc.get("chief_complaint") or {}).get("text", "")
        history = list((payload_pc.get("history") or {}).get("conditions") or [])
    evidence = {
        "symptoms": snapshot.get("evidence", {}).get("symptoms", []),
        "conditions": snapshot.get("conditions", []),
    }
    patient_info = {
        "name": patient.name,
        "age": patient.age,
        "gender": patient.gender,
        "chief_complaint": chief_complaint,
        "history": history,
    }
    review = review_match(db, run, patient_info, evidence, candidates, profiles)
    audit.record(db, user, "ai_review", "matching", run.id, {"model": review.model})
    db.commit()
    return review.to_dict()


def _run_payload(db: Session, run: MatchRun) -> dict:
    candidates = (
        db.query(MatchCandidate).filter(MatchCandidate.run_id == run.id).order_by(MatchCandidate.rank).all()
    )
    alert = (
        db.query(Alert).filter(Alert.match_run_id == run.id).order_by(Alert.id.desc()).first()
    )
    return {
        "id": run.id,
        "patient_id": run.patient_id,
        "created_at": run.created_at.isoformat(),
        "rule_version": run.rule_version,
        "thresholds": run.thresholds,
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
                "protective_signs": row.protective_signs,
                "risk_factor_hits": row.risk_factor_hits,
                "pattern_hits": row.pattern_hits,
                "distinctive_symptoms": row.distinctive_symptoms,
                "shared_symptoms": row.shared_symptoms,
                "risk_level": row.risk_level,
                "advice": row.advice,
                "evidence_insufficient": row.evidence_insufficient,
            }
            for row in candidates
        ],
        "alert": {
            "id": alert.id if alert else None,
            "level": alert.level if alert else "",
            "message": alert.message if alert else "",
            "department": alert.department if alert else "",
            "status": alert.status if alert else "",
        }
        if alert
        else {},
        "disclaimer": DISCLAIMER,
    }


@router.get("/matching/runs")
def list_match_runs(
    patient_id: int = 0,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    query = db.query(MatchRun)
    if patient_id:
        query = query.filter(MatchRun.patient_id == patient_id)
    rows = query.order_by(MatchRun.id.desc()).limit(50).all()
    return [
        {
            "id": row.id,
            "patient_id": row.patient_id,
            "created_at": row.created_at.isoformat(),
            "rule_version": row.rule_version,
        }
        for row in rows
    ]


@router.get("/matching/runs/{run_id}")
def get_match_run(run_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    run = db.get(MatchRun, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="匹配批次不存在")
    return _run_payload(db, run)


@router.post("/matching/runs/{run_id}/ai-review")
def post_ai_review(
    run_id: int,
    user: User = Depends(require_staff),
    db: Session = Depends(get_db),
):
    """对一次匹配批次执行 AI 语义复核。

    AI 只给**建议**：排序建议、补充问诊清单、通俗解释、与规则的分歧说明；
    不修改匹配度、参考概率、阈值与提醒等级（红线）。
    """
    run = db.get(MatchRun, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="匹配批次不存在")
    patient = db.get(Patient, run.patient_id)
    if patient is None:
        raise HTTPException(status_code=404, detail="患者不存在")
    return _run_ai_review(db, run, user, patient)


@router.get("/matching/runs/{run_id}/ai-review")
def get_ai_review(
    run_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """读取该批次最近一次 AI 复核结果。"""
    record = (
        db.query(MatchAiReview)
        .filter(MatchAiReview.run_id == run_id)
        .order_by(MatchAiReview.id.desc())
        .first()
    )
    if record is None:
        raise HTTPException(status_code=404, detail="该批次尚未进行 AI 复核")
    return {
        "id": record.id,
        "run_id": record.run_id,
        "patient_id": record.patient_id,
        "model": record.model,
        "prompt_version": record.prompt_version,
        "latency_ms": record.latency_ms,
        "created_at": record.created_at.isoformat(),
        **record.output,
    }


@router.get("/matching/thresholds")
def list_thresholds(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    weights = _weights(db)
    rows = db.query(AlertThreshold).order_by(AlertThreshold.id).all()
    return {
        "thresholds": [
            {
                "id": row.id,
                "scope": row.scope,
                "disease_code": row.disease_code,
                "threshold": row.threshold,
                "level": row.level,
                "review_status": row.review_status,
                "updated_by": row.updated_by,
                "updated_at": row.updated_at.isoformat(),
                "comment": row.comment,
            }
            for row in rows
        ],
        "weights": weights.to_dict(),
    }


@router.put("/matching/thresholds/{threshold_id}")
def update_threshold(
    threshold_id: int,
    payload: dict,
    user: User = Depends(require_roles(ROLE_ADMIN, ROLE_DOCTOR)),
    db: Session = Depends(get_db),
):
    """阈值变更需审批并留痕（红线 5、7）。"""
    row = db.get(AlertThreshold, threshold_id)
    if row is None:
        raise HTTPException(status_code=404, detail="阈值不存在")
    before = row.threshold
    if "threshold" in payload:
        row.threshold = float(payload["threshold"])
    if "level" in payload:
        row.level = payload["level"]
    if "review_status" in payload:
        row.review_status = payload["review_status"]
    row.updated_by = user.full_name or user.username
    row.comment = payload.get("comment", row.comment)
    db.commit()
    audit.record(
        db,
        user,
        "update_threshold",
        "alert_threshold",
        threshold_id,
        {"from": before, "to": row.threshold, "comment": row.comment},
    )
    db.commit()
    return {"id": row.id, "threshold": row.threshold, "level": row.level, "review_status": row.review_status}
