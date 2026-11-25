"""评估证据包：把一次评估的作答与判读明细导出成可留档的文件。

A 线的交付物是「可信的结构化评估证据」，但在此之前这份证据只活在接口响应里：
页面一刷新就没了，复核、留档、写报告时都得重新点一遍，也无法证明「当时到底答了
什么、怎么算出来的」。本模块把一次评估的**原始明细**落成文件：

- `GET /assessments/{session_id}/evidence`    结构化 JSON 证据包（含自洽校验）
- `GET /assessments/{session_id}/evidence.csv` 逐题明细表（Excel 可直接打开）

边界：导出的是「作答与判读的原始明细」，不是结论性报告。报告模板、章节、导出
格式属 B 线，本模块不碰，也不复用 `reports` 的任何逻辑。
"""

from __future__ import annotations

import csv
import datetime as dt
import io
from urllib.parse import quote

from fastapi import Depends, HTTPException
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app.api import new_router
from app.core.deps import ensure_patient_access, get_current_user
from app.db.base import get_db
from app.db.models import AssessmentAnswer, AssessmentScore, AssessmentSession, Patient, User
from app.services import audit
from app.services.scales_store import get_scale

router = new_router()

# 证据包格式版本：字段增删时递增，避免导入方按旧结构解析出错。
EVIDENCE_SCHEMA = "cga.evidence/v1"

# 单题作答快于该秒数、或整卷平均每题快于该秒数时给出「作答过快」提示。
# 只做提示不做判废：老人手速、陪同者代点都可能造成秒答，结论仍交给人工判断。
FAST_ITEM_SECONDS = 1.0
FAST_AVERAGE_SECONDS = 3.0

STATUS_LABEL = {"answered": "已作答", "skipped": "已跳过", "unanswered": "未作答"}
SOURCE_LABEL = {"self": "本人", "proxy": "家属代答", "staff": "工作人员"}


# ---------------------------------------------------------------- 量表侧索引


def _question_index(scale: dict) -> dict[str, dict]:
    """题目编码 → 题干与所属维度，用于给作答补全语义。"""
    index: dict[str, dict] = {}
    for section in scale.get("sections", []):
        for question in section.get("questions", []):
            code = question.get("code")
            if not code:
                continue
            index[code] = {
                "text": question.get("text", ""),
                "plain_text": question.get("plain_text", ""),
                "section_title": section.get("title", ""),
                "options": question.get("options", []),
            }
    return index


def _rule_index(scale: dict) -> tuple[str, dict[str, float]]:
    """返回 (计分规则类型, 题码→满分)。

    满分优先取 `scoring.score.config.items[].max_score`（这是判读实际使用的口径），
    取不到才回落到选项里的最大分值——两处不一致时以规则配置为准。
    """
    scoring = (scale.get("scoring") or {}).get("score") or {}
    rule_type = str(scoring.get("rule_type") or "")
    config = scoring.get("config") or {}
    maxes: dict[str, float] = {}
    for item in config.get("items") or []:
        code = item.get("code")
        if code:
            maxes[str(code)] = float(item.get("max_score") or 0)
    return rule_type, maxes


def _option_label(options: list[dict], value: str) -> str:
    """把存下来的原始值翻回选项文本；匹配不到时原样返回，不猜。"""
    for option in options:
        if str(option.get("value", "")) == str(value):
            return str(option.get("label", ""))
    return ""


def _max_of(options: list[dict], value: str) -> float:
    """选项分值取最大值作为该题满分（规则未声明时用）。"""
    scores = [float(option.get("score") or 0) for option in options]
    return max(scores) if scores else 0.0


# ---------------------------------------------------------------- 明细组装


def _item_rows(db: Session, session: AssessmentSession, scale: dict) -> list[dict]:
    """按问卷顺序列出每一题：答了的、跳过的、压根没答的都占一行。

    未作答也保留，是因为「证据」的完整性恰恰体现在缺口上——只导出已答题目，
    会让一份缺 8 题的评估看起来像完整评估。
    """
    index = _question_index(scale)
    rule_type, maxes = _rule_index(scale)
    records = {
        row.question_code: row
        for row in db.query(AssessmentAnswer).filter(AssessmentAnswer.session_id == session.id).all()
    }

    # 问卷顺序优先；题库里已删、但历史上答过的题追加在末尾，不丢数据。
    codes = list(index) + sorted(code for code in records if code not in index)

    rows: list[dict] = []
    for seq, code in enumerate(codes, start=1):
        meta = index.get(code, {})
        record = records.get(code)
        options = meta.get("options", [])

        if record is None:
            status = "unanswered"
        elif record.skipped:
            status = "skipped"
        else:
            status = "answered"

        answered_at = record.answered_at if record is not None else None
        rows.append(
            {
                "seq": seq,
                "question_code": code,
                "section_title": meta.get("section_title", ""),
                "text": meta.get("text", ""),
                "plain_text": meta.get("plain_text", ""),
                "raw_value": record.value if record is not None else "",
                "value_label": _option_label(options, record.value) if record is not None else "",
                "measured": record.measured if record is not None else None,
                "score": record.score if record is not None else None,
                "max_score": maxes.get(code, _max_of(options, "")),
                "status": status,
                "skip_reason": record.skip_reason if record is not None else "",
                "answer_source": record.answer_source if record is not None else "",
                "answered_by": record.answered_by if record is not None else "",
                "answered_at": answered_at.isoformat() if answered_at else "",
                # 下划线开头的是内部字段，序列化前统一剔除
                "_answered_at": answered_at,
                "_rule_type": rule_type,
            }
        )
    return rows


def _pace(items: list[dict]) -> dict:
    """作答节奏：整卷平均每题秒数与「秒答」题数。

    用相邻作答时间差算单题耗时，而不是「总时长 ÷ 题数」——后者在断点续填
    （隔天再答）时会算出几万秒，完全没有参考价值。
    """
    stamps = sorted(
        item["_answered_at"] for item in items if item["status"] == "answered" and item["_answered_at"]
    )
    if len(stamps) < 2:
        return {"average_seconds": None, "fast_items": 0, "span_seconds": None}

    gaps = [(later - earlier).total_seconds() for earlier, later in zip(stamps, stamps[1:])]
    span = (stamps[-1] - stamps[0]).total_seconds()
    return {
        "average_seconds": round(span / len(gaps), 1),
        "fast_items": sum(1 for gap in gaps if gap < FAST_ITEM_SECONDS),
        "span_seconds": round(span, 1),
    }


def _integrity(
    session: AssessmentSession,
    score: AssessmentScore | None,
    items: list[dict],
    rule_type: str,
) -> dict:
    """证据自洽校验：这份明细能不能支撑那个总分，缺什么、哪里对不上。

    这不是医学判断，只是算术核对——但恰恰是复核时最先要看的一步：
    「逐题得分加起来不等于总分」这种事故，光看报告页是看不出来的。
    """
    answered = [item for item in items if item["status"] == "answered"]
    skipped = [item for item in items if item["status"] == "skipped"]
    unanswered = [item for item in items if item["status"] == "unanswered"]
    proxy = [item for item in answered if item["answer_source"] == "proxy"]

    item_sum = round(sum(float(item["score"] or 0) for item in answered), 2)
    positive = sum(1 for item in answered if float(item["score"] or 0) > 0)
    max_sum = round(sum(float(item["max_score"] or 0) for item in items), 2)

    # 按规则类型核对总分：求和型比数值，计数型比阳性条数。
    expected: float | None = None
    if score is not None:
        if rule_type == "sum":
            expected = item_sum
        elif rule_type == "count_positive":
            expected = float(positive)

    consistent: bool | None = None
    if expected is not None and score is not None:
        consistent = abs(expected - float(score.total or 0)) <= 0.01

    warnings: list[str] = []
    if session.status == "in_progress":
        warnings.append(f"本次评估尚未完成（状态「{session.status}」），导出内容为阶段快照，不是最终结论")
    elif session.status == "abandoned":
        warnings.append("本次评估已放弃，导出内容仅供追溯，不构成评估结论")
    if unanswered:
        warnings.append(f"有 {len(unanswered)} 题从未作答，该量表结论可能不成立")
    if skipped:
        warnings.append(f"有 {len(skipped)} 题被跳过（原因见逐题明细），计分时按规则处理")
    if proxy:
        warnings.append(f"有 {len(proxy)} 题由家属代答，结论基于转述而非本人陈述")
    if consistent is False and score is not None:
        warnings.append(
            f"逐题得分合计 {expected} 与总分 {float(score.total or 0)} 不一致，需人工复核"
        )
    if score is not None and score.needs_manual_review:
        warnings.append("判读结果已标记为「需人工复核」，请勿直接采信")

    pace = _pace(items)
    if pace["fast_items"] >= 3:
        warnings.append(f"有 {pace['fast_items']} 题作答间隔不足 {FAST_ITEM_SECONDS:g} 秒，建议核实是否本人作答")
    if pace["average_seconds"] is not None and pace["average_seconds"] < FAST_AVERAGE_SECONDS:
        warnings.append(f"整卷平均每题 {pace['average_seconds']} 秒，作答速度明显偏快")

    completeness = round(len(answered) / len(items), 4) if items else 0.0

    return {
        "total_items": len(items),
        "answered": len(answered),
        "skipped": len(skipped),
        "unanswered": len(unanswered),
        "proxy_answered": len(proxy),
        "completeness": completeness,
        "max_possible_score": max_sum,
        "item_score_sum": item_sum,
        "positive_items": positive,
        "rule_type": rule_type,
        "expected_total": expected,
        "recorded_total": float(score.total) if score is not None else None,
        "rule_consistent": consistent,
        "pace": pace,
        "warnings": warnings,
        # 「证据可用」= 算术对得上 + 没有缺口。跳过与未作答都算缺口：缺一题的总分
        # 与满分卷不可比，不能因为「加总没错」就判定证据完整。
        "passed": bool(consistent is not False and not unanswered and not skipped),
    }


def _clean(items: list[dict]) -> list[dict]:
    """剔除内部字段（下划线前缀）后的可序列化明细。"""
    return [{key: value for key, value in item.items() if not key.startswith("_")} for item in items]


def _patient_brief(patient: Patient | None) -> dict:
    if patient is None:
        return {}
    age = None
    if patient.birth_date:
        today = dt.date.today()
        age = today.year - patient.birth_date.year - (
            (today.month, today.day) < (patient.birth_date.month, patient.birth_date.day)
        )
    return {
        "id": patient.id,
        "code": patient.code,
        "name": patient.name,
        "gender": patient.gender,
        "birth_date": patient.birth_date.isoformat() if patient.birth_date else "",
        "age": age,
        # 身份证只给脱敏值：证据包会被下载、转发，不能带全量身份信息
        "id_card_masked": patient.id_card_masked,
    }


def _load(db: Session, session_id: int, user: User) -> tuple[AssessmentSession, dict, AssessmentScore | None]:
    session = db.get(AssessmentSession, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="评估任务不存在")
    ensure_patient_access(user, session.patient_id)
    scale = get_scale(db, session.scale_code) or {}
    score = db.query(AssessmentScore).filter(AssessmentScore.session_id == session_id).first()
    return session, scale, score


def _file_stem(session: AssessmentSession, scale: dict) -> str:
    name = (scale.get("name") or session.scale_code).replace("/", "-")
    return f"评估证据_{session.scale_code}_{name}_{session.id}"


# ---------------------------------------------------------------- 端点


@router.get("/assessments/{session_id}/evidence")
def assessment_evidence(
    session_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """结构化证据包：一次评估的来龙去脉，可直接入库或作为附件留档。"""
    session, scale, score = _load(db, session_id, user)
    items = _item_rows(db, session, scale)
    rule_type, _ = _rule_index(scale)

    duration = None
    if session.started_at and session.finished_at:
        duration = int((session.finished_at - session.started_at).total_seconds())

    payload = {
        "schema": EVIDENCE_SCHEMA,
        "exported_at": dt.datetime.now().isoformat(timespec="seconds"),
        "exported_by": {"id": user.id, "name": user.full_name, "role": user.role},
        "patient": _patient_brief(db.get(Patient, session.patient_id)),
        "session": {
            "id": session.id,
            "status": session.status,
            "scale_code": session.scale_code,
            "scale_name": scale.get("name", session.scale_code),
            "dimension": scale.get("dimension", ""),
            "scale_version": session.scale_version,
            "rule_version": session.rule_version,
            "responder": session.responder,
            "proxy_name": session.proxy_name,
            "proxy_relation": session.proxy_relation,
            "progress": session.progress,
            "started_at": session.started_at.isoformat() if session.started_at else "",
            "finished_at": session.finished_at.isoformat() if session.finished_at else "",
            "duration_seconds": duration,
            "dispatched_from_id": session.dispatched_from_id,
            "dispatch_branch_code": session.dispatch_branch_code,
            "dispatch_reason": session.dispatch_reason,
        },
        "score": (
            {
                "total": score.total,
                "level": score.level,
                "interpretation": score.interpretation,
                "abnormal": score.abnormal,
                "severity": score.severity,
                "flags": score.flags,
                "missing_items": score.missing_items,
                "needs_manual_review": score.needs_manual_review,
                "rule_refs": score.rule_refs,
                "explanation": score.explanation,
                "created_at": score.created_at.isoformat() if score.created_at else "",
            }
            if score is not None
            else None
        ),
        "items": _clean(items),
        "integrity": _integrity(session, score, items, rule_type),
    }

    audit.record(
        db,
        user,
        action="export_evidence",
        target_type="assessment_session",
        target_id=session.id,
        detail={"format": "json", "items": len(items)},
    )
    db.commit()
    return payload


@router.get("/assessments/{session_id}/evidence.csv")
def assessment_evidence_csv(
    session_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """逐题明细 CSV。

    Excel 打开中文 CSV 时若无 BOM 会整体乱码，因此用 `utf-8-sig` 编码；
    文件名同时给 ASCII 兜底与 RFC 5987 的 `filename*`，中文名在主流浏览器可用。
    """
    session, scale, _ = _load(db, session_id, user)
    items = _item_rows(db, session, scale)

    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(
        ["序号", "题目编码", "所属维度", "题目", "口语化问法", "实测值", "作答文本", "得分", "满分",
         "作答状态", "跳过原因", "作答来源", "作答人", "作答时间"]
    )
    for item in items:
        writer.writerow(
            [
                item["seq"],
                item["question_code"],
                item["section_title"],
                item["text"],
                item["plain_text"],
                "" if item["measured"] is None else item["measured"],
                item["value_label"],
                "" if item["score"] is None else item["score"],
                item["max_score"],
                STATUS_LABEL.get(item["status"], item["status"]),
                item["skip_reason"],
                SOURCE_LABEL.get(item["answer_source"], item["answer_source"]),
                item["answered_by"],
                # 截到秒：微秒在 Excel 里会把列撑宽，对留档毫无价值
                item["answered_at"][:19].replace("T", " "),
            ]
        )

    body = buffer.getvalue().encode("utf-8-sig")
    stem = _file_stem(session, scale)

    audit.record(
        db,
        user,
        action="export_evidence",
        target_type="assessment_session",
        target_id=session.id,
        detail={"format": "csv", "items": len(items)},
    )
    db.commit()

    return Response(
        content=body,
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": (
                f'attachment; filename="evidence_{session.id}.csv"; '
                f"filename*=UTF-8''{quote(stem + '.csv')}"
            ),
            "X-Evidence-Items": str(len(items)),
        },
    )
