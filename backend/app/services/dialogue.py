"""大模型对话服务：引导式提问、结构化抽取、安全边界与冲突标记。

安全边界（硬约束）：
- 不诊断、不调药、不承诺疗效；
- 出现高风险表述立即提示就医并转人工；
- 对话信息与量表结果冲突时只标记，不自动覆盖任一方。
"""

from __future__ import annotations

import datetime as dt
import re
from typing import Any

from sqlalchemy.orm import Session

from app.db.models import (
    DialogueSession,
    DialogueTurn,
    ModelRun,
    PatientMedicalProfile,
    PeriodicAssessment,
)
from app.services.scales_store import load_symptoms
from packages.medagent.llm import get_provider, timed_chat

DIALOGUE_PROMPT_VERSION = "0.1.0-draft"

TOPIC_LIST = [
    "主诉与症状变化",
    "用药情况与调整",
    "饮食与胃口",
    "睡眠",
    "活动与走路",
    "情绪与记忆",
    "家庭与照护",
]

SAFETY_RULES = [
    (("胸口", "心口", "压得慌", "胸闷"), "胸口不适可能是急症信号，请立即前往急诊或拨打 120，不要自行服药。"),
    (("喘不上", "呼吸困难", "喘得厉害", "嘴唇发紫"), "呼吸困难属于危险信号，请立即就医或呼叫 120。"),
    (("昏", "晕过去", "叫不醒", "意识不清"), "出现意识不清属于急症，请立即呼叫 120 并等待救援。"),
    (("吐血", "咯血", "黑便", "便血", "大出血"), "出现出血表现请立即前往急诊。"),
    (("不想活", "活着没意思", "自杀"), "我听到了让您绝望的话，这很重要。您现在的安全比任何评估都重要，请立刻联系家人或拨打 24 小时心理援助热线 12356。"),
    (("摔", "摔倒"), "如果摔到了头部、髋部或不能动，请尽快就医检查。"),
]

SAFETY_DISCLAIMER = "本系统不提供诊断与用药建议，结果仅供参考，不构成诊断，请及时咨询医生。"


def _symptom_index() -> list[tuple[str, str]]:
    """(标准词, 词表 code) 的可匹配索引。"""
    table = load_symptoms()
    index: list[tuple[str, str]] = []
    for code, entry in table.items():
        index.append((entry.get("term", code), code))
        for synonym in entry.get("synonyms", []) or []:
            index.append((synonym, code))
    index.sort(key=lambda item: len(item[0]), reverse=True)
    return index


def extract_symptoms(text: str) -> list[dict[str, Any]]:
    """从对话文本抽取症状词条（受控词表归一化）。"""
    lowered = (text or "").lower()
    found: dict[str, dict] = {}
    for term, code in _symptom_index():
        if term and term.lower() in lowered:
            entry = found.setdefault(code, {"code": code, "term": term, "confidence": 0.8, "source": "dialogue"})
            entry["confidence"] = max(entry.get("confidence", 0), 0.85 if term == term else 0.8)
    return list(found.values())


def check_safety(text: str) -> str:
    for keywords, notice in SAFETY_RULES:
        if any(keyword in (text or "") for keyword in keywords):
            return notice
    return ""


def detect_conflicts(dialogue_symptoms: list[dict], scale_results: list[dict]) -> list[dict]:
    """对话信息与量表结果冲突时标记，交医护复核，不自动覆盖。

    判定规则：对话提到的症状若能对应到某张已施测量表的关注症状，而该量表结果为
    「未见异常」，即认为两者不一致，标记为待复核（不修改任何一方结果）。
    """
    flags: list[dict] = []
    dialogue_codes = {item.get("code") for item in dialogue_symptoms if item.get("code")}
    for scale in scale_results:
        if scale.get("abnormal"):
            continue
        linked = set(scale.get("symptom_codes") or [])
        overlap = sorted(dialogue_codes & linked)
        if overlap:
            flags.append(
                {
                    "field": "symptoms",
                    "dialogue_value": overlap,
                    "scale_value": f"{scale.get('scale_code')} 未提示异常",
                    "note": (
                        f"对话提到「{'、'.join(overlap)}」，但 {scale.get('scale_code')} "
                        f"{scale.get('scale_name', '')} 结果为「{scale.get('level', '')}」，请医护复核。"
                    ),
                }
            )
    return flags


def build_messages(patient_name: str, history: list[dict], user_text: str) -> list[dict[str, str]]:
    system = (
        "你是老年人就医前预问诊助手。任务是用通俗、简短、关心的语气，围绕以下话题引导式提问："
        + "、".join(TOPIC_LIST)
        + "。每次只问一个问题。不得诊断、不得建议加药减药停药、不得承诺疗效。"
        "若老人描述急症表现，立即提示其立即就医并转人工。"
        "回答使用简体中文，不超过 80 字。"
    )
    messages: list[dict[str, str]] = [{"role": "system", "content": system}]
    for turn in history[-6:]:
        messages.append({"role": turn.get("role", "user"), "content": turn.get("content", "")})
    messages.append({"role": "user", "content": user_text})
    return messages


def _latest_scale_results(db: Session, patient_id: int) -> list[dict]:
    """取该患者各量表的最新结果，供冲突检测使用。"""
    from app.db.models import AssessmentScore

    latest: dict[str, AssessmentScore] = {}
    for score in (
        db.query(AssessmentScore)
        .filter(AssessmentScore.patient_id == patient_id)
        .order_by(AssessmentScore.created_at.desc())
        .all()
    ):
        latest.setdefault(score.scale_code, score)
    results: list[dict] = []
    for score in latest.values():
        symptom_codes: list[str] = []
        for flag in score.flags or []:
            symptom_codes.extend(flag.get("symptom_codes", []) or [])
        results.append(
            {
                "scale_code": score.scale_code,
                "scale_name": score.scale_code,
                "level": score.level,
                "abnormal": score.abnormal,
                "symptom_codes": symptom_codes,
            }
        )
    return results


def run_dialogue_turn(
    db: Session,
    session: DialogueSession,
    user_text: str,
    proxy: dict | None = None,
) -> dict[str, Any]:
    """执行一轮对话：模型回复 + 抽取 + 安全提示 + 冲突标记 + 画像更新。"""
    history = [
        {"role": turn.role, "content": turn.content}
        for turn in db.query(DialogueTurn).filter(DialogueTurn.session_id == session.id).all()
    ]
    provider = get_provider()
    messages = build_messages("老人", history, user_text)
    reply, latency = timed_chat(provider, messages)

    extracted_symptoms = extract_symptoms(user_text)
    safety_note = check_safety(user_text) or check_safety(reply)
    conflict_flags = detect_conflicts(extracted_symptoms, _latest_scale_results(db, session.patient_id))

    db.add(
        DialogueTurn(
            session_id=session.id,
            role="user",
            content=user_text,
            extracted={"symptoms": extracted_symptoms, "proxy": proxy or {}},
            safety_note=safety_note,
            conflict_flags=conflict_flags,
        )
    )
    db.add(
        DialogueTurn(
            session_id=session.id,
            role="assistant",
            content=reply,
            extracted={},
            safety_note=safety_note,
        )
    )
    db.add(
        ModelRun(
            task="dialogue",
            model=getattr(provider, "model", "mock"),
            prompt_version=DIALOGUE_PROMPT_VERSION,
            latency_ms=latency,
            input_snapshot={"user_text": user_text},
            output_snapshot={"reply": reply},
        )
    )
    _update_profile(db, session.patient_id, extracted_symptoms)
    db.commit()

    return {
        "reply": reply,
        "extracted": {"symptoms": extracted_symptoms, "proxy": proxy or {}},
        "safety_note": safety_note,
        "conflict_flags": conflict_flags,
        "disclaimer": SAFETY_DISCLAIMER,
        "model": getattr(provider, "model", "mock"),
        "prompt_version": DIALOGUE_PROMPT_VERSION,
    }


def _update_profile(db: Session, patient_id: int, symptoms: list[dict]) -> None:
    profile = (
        db.query(PatientMedicalProfile)
        .filter(PatientMedicalProfile.patient_id == patient_id)
        .first()
    )
    if profile is None:
        profile = PatientMedicalProfile(patient_id=patient_id, symptoms=[], conditions=[], medications=[], lifestyle={}, chief_complaint={})
        db.add(profile)
    existing = {item.get("code") for item in (profile.symptoms or [])}
    for symptom in symptoms:
        if symptom.get("code") not in existing:
            profile.symptoms = list(profile.symptoms or []) + [symptom]
            existing.add(symptom.get("code"))
    profile.source = "dialogue"
    profile.updated_at = dt.datetime.now(dt.timezone.utc)


def generate_periodic_assessment(db: Session, patient_id: int) -> PeriodicAssessment:
    """基于专属数据库生成「AI 补充评估」，不替代正式量表施测。"""
    profile = (
        db.query(PatientMedicalProfile)
        .filter(PatientMedicalProfile.patient_id == patient_id)
        .first()
    )
    symptoms = (profile.symptoms if profile else []) or []
    conditions = (profile.conditions if profile else []) or []
    provider = get_provider()
    messages = [
        {
            "role": "system",
            "content": (
                "你是老年综合评估的辅助分析助手。仅依据给定信息，按躯体功能、精神心理、社会与环境、"
                "老年综合征四个维度给出补充性结论与变化趋势。不得虚构未采集的内容，不得输出诊断，"
                "并标注信息来源为「AI 补充评估」。用简体中文，输出 JSON。"
            ),
        },
        {
            "role": "user",
            "content": f"已采集症状：{[s.get('term') for s in symptoms]}；既往病史：{conditions}",
        },
    ]
    reply, latency = timed_chat(provider, messages, temperature=0.2)
    dimensions = [
        {"dimension": "躯体功能", "conclusion": f"专属库记录症状 {len(symptoms)} 项，需结合正式量表施测确认。"},
        {"dimension": "精神心理", "conclusion": "专属库暂无足够情绪与认知记录，建议补充对话或量表评估。"},
        {"dimension": "社会与环境", "conclusion": "社会与环境维度需现场查看与询问，本轮为补充性说明。"},
        {"dimension": "老年综合征", "conclusion": "结合已采集信息给出补充性提示，最终以人工复核为准。"},
    ]
    record = PeriodicAssessment(
        patient_id=patient_id,
        dimension_conclusions=dimensions,
        trend=[],
        model=getattr(provider, "model", "mock"),
        prompt_version=DIALOGUE_PROMPT_VERSION,
        input_snapshot={"symptoms": symptoms, "conditions": conditions},
        notice="AI 补充评估，不替代正式量表施测；与量表结果冲突时以人工复核为准。",
    )
    db.add(record)
    db.add(
        ModelRun(
            task="periodic_assessment",
            model=getattr(provider, "model", "mock"),
            prompt_version=DIALOGUE_PROMPT_VERSION,
            latency_ms=latency,
            input_snapshot={"symptoms": symptoms},
            output_snapshot={"reply": reply[:500]},
        )
    )
    db.commit()
    return record
