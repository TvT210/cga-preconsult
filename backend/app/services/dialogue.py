"""大模型对话服务：引导式提问、结构化抽取、安全边界与冲突标记。

安全边界（硬约束）：
- 不诊断、不调药、不承诺疗效；
- 出现高风险表述立即提示就医并转人工；
- 对话信息与量表结果冲突时只标记，不自动覆盖任一方。
"""

from __future__ import annotations

import datetime as dt
import re
from dataclasses import dataclass
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
from app.services.prompt_store import (
    PROMPT_CODE_DIALOGUE,
    PROMPT_CODE_PERIODIC,
    resolve_prompt,
)
from packages.medagent.llm import LLMEmptyResponse, get_provider, timed_chat

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


# ---------------------------------------------------------------------------
# 否定 / 停用表述
#
# 冲突检测要判断「对话说的」与「已记录的不一致」，就必须先听懂否定：
# 「我没有高血压」不是「我有高血压」，「氨氯地平已经停了」也不是「还在吃」。
#
# 这里刻意只做规则匹配，不引入模型判断：冲突标记要能解释「凭什么标」，
# 也要能写成断言。规则会误报（宁可多报交医护复核，不可漏报），但不会把
# 一句正常描述静默当成反面证据。
# ---------------------------------------------------------------------------

# 否定词。按长度倒序匹配，长词优先（「从来没有」不会被「没有」抢先截断）。
NEGATION_CUES = ("从来没有", "从来没", "不曾", "否认", "没有", "没", "不", "未", "无")

# 否定词与目标词之间允许出现的虚词长度（如「没有**明显**头晕」）。
# 放太宽会把「不想吃饭还腹泻」里的腹泻也当成被否定。
NEGATION_GAP = 3

# 停用表述。只收足够特异的说法，「不吃药」这类整体陈述不在其列。
STOP_CUES = ("已经停", "停药", "停用", "停了", "不吃了", "没吃了", "没在吃", "不再吃", "断药")

# 停用词的否定前置：这些出现时说明是「不能停」，不是「已经停」。
STOP_VETO = ("不能", "不敢", "不可", "别", "不要")

# 转折词：否定只作用于本分句，越过转折就要重新计。
PIVOT_CUES = ("但是", "可是", "不过", "然而", "但", "却")

# 分句切分。中文逗号在口语里也可能只是停顿，所以转折词另算一层。
CLAUSE_SEP = re.compile(r"[，,。；;！!？?\n\r]")


def _clauses(text: str) -> list[str]:
    """按标点切分句，用于把否定限定在本分句内。"""
    return [part.strip() for part in CLAUSE_SEP.split(text or "") if part.strip()]


def _snippet(clause: str, term: str, span: int = 6) -> str:
    """截出目标词前后的原文，供医护核对「模型到底读到了哪句话」。"""
    pos = clause.find(term)
    if pos < 0:
        return clause[: span * 2]
    start = max(0, pos - span)
    end = min(len(clause), pos + len(term) + span)
    prefix = "…" if start > 0 else ""
    suffix = "…" if end < len(clause) else ""
    return f"{prefix}{clause[start:end]}{suffix}"


def _negation_hit(clause: str, term: str) -> str | None:
    """该词在本分句内被否定时，返回命中原句；否则 None。

    判定要点：否定词必须落在目标词之前，且两者之间只隔虚词（≤ ``NEGATION_GAP``），
    中间若出现转折词则否定范围到此为止。
    """
    start = 0
    while True:
        pos = clause.find(term, start)
        if pos < 0:
            return None
        head = clause[:pos]
        # 转折词之后的否定才算数：「没有高血压，但头晕」里「头晕」不能被否定
        pivot_end = 0
        for cue in PIVOT_CUES:
            cue_pos = head.rfind(cue)
            if cue_pos >= 0:
                pivot_end = max(pivot_end, cue_pos + len(cue))
        if pivot_end > 0:
            head = head[pivot_end:]
        for cue in NEGATION_CUES:
            cue_pos = head.rfind(cue)
            if cue_pos < 0:
                continue
            gap = len(head) - (cue_pos + len(cue))
            if 0 <= gap <= NEGATION_GAP:
                return _snippet(clause, term)
        start = pos + len(term)


def _stop_hit(clause: str, name: str) -> str | None:
    """药名在本分句内被说明为已停用时，返回命中原句。

    「氨氯地平不能停」不算停用——把停用词的否定前置单独挡掉，
    否则一句叮嘱会被记成一次用药冲突。
    """
    if not name or name not in clause:
        return None
    for cue in STOP_CUES:
        pos = clause.find(cue)
        if pos < 0:
            continue
        before = clause[max(0, pos - 2) : pos]
        if any(veto in before for veto in STOP_VETO):
            continue
        return _snippet(clause, name)
    return None


def _name_variants(name: str) -> list[str]:
    """病名的可匹配写法。

    画像记「2 型糖尿病」，老人开口只说「糖尿病」——只按全名找会整类漏判。
    去掉型别前缀后长度仍够（≥2 字）才作为变体，避免「1 型」这类短词误匹配。
    """
    variants = [name]
    core = re.sub(r"^[0-9一二三四五六七八九十]+\s*型", "", name).strip()
    if core and core != name and len(core) >= 2:
        variants.append(core)
    return variants


def extract_negations(
    text: str,
    *,
    condition_names: list[str] | None = None,
    medication_names: list[str] | None = None,
) -> list[dict[str, Any]]:
    """抽取「被明确否认 / 已停用」的陈述。

    只针对**已知候选**判否定：症状走受控词表，病史与用药走该患者已有记录。
    不给候选就不猜——自由抽取病名药名会引入大量错位匹配，冲突标记的
    可信度比覆盖面更重要。

    :return: ``[{"kind": "symptom|condition|medication", "ref": 编码或名称,
                 "term": 命中词, "evidence": 原句}, ...]``
    """
    found: dict[tuple[str, str], dict[str, Any]] = {}
    conditions = [term.strip() for term in (condition_names or []) if term and term.strip()]
    medications = [name.strip() for name in (medication_names or []) if name and name.strip()]

    for clause in _clauses(text):
        for term, code in _symptom_index():
            if term and term in clause:
                evidence = _negation_hit(clause, term)
                if evidence:
                    found.setdefault(
                        ("symptom", code),
                        {"kind": "symptom", "ref": code, "term": term, "evidence": evidence},
                    )
        for name in conditions:
            evidence = next(
                (hit for variant in _name_variants(name) if (hit := _negation_hit(clause, variant))),
                None,
            )
            if evidence:
                found.setdefault(
                    ("condition", name),
                    {"kind": "condition", "ref": name, "term": name, "evidence": evidence},
                )
        for name in medications:
            evidence = _stop_hit(clause, name)
            if evidence:
                found.setdefault(
                    ("medication", name),
                    {"kind": "medication", "ref": name, "term": name, "evidence": evidence},
                )
    return list(found.values())


# 冲突类别的中文名与严重度。老人端只该看到人话，医护端需要能按类分流。
CONFLICT_META: dict[str, dict[str, str]] = {
    "symptoms": {"title": "症状与量表结果不一致", "severity": "warn"},
    "complaint": {"title": "主诉与后续描述不一致", "severity": "info"},
    "medication": {"title": "用药记录与对话描述不一致", "severity": "warn"},
    "history": {"title": "既往史与对话描述不一致", "severity": "warn"},
}


def _flag(
    kind: str,
    *,
    dialogue_value,
    note: str,
    scale_value: str = "",
    profile_value="",
    evidence: str = "",
) -> dict[str, Any]:
    """构造一条冲突标记。

    ``field`` 保留为类别英文键：旧前端按它拼提示，改结构不能把老页面打空。
    ``kind`` 与 ``field`` 同值，单独留一个语义明确的名字给新调用方。
    """
    meta = CONFLICT_META.get(kind, {"title": "信息不一致", "severity": "info"})
    return {
        "kind": kind,
        "field": kind,
        "severity": meta["severity"],
        "title": meta["title"],
        "dialogue_value": dialogue_value,
        "scale_value": scale_value,
        "profile_value": profile_value,
        "evidence": evidence,
        "note": note,
    }


def detect_conflicts(
    dialogue_symptoms: list[dict],
    scale_results: list[dict],
    *,
    negations: list[dict] | None = None,
    profile_conditions: list[str] | None = None,
    profile_medications: list[str] | None = None,
    chief_complaint: dict | None = None,
) -> list[dict]:
    """对话信息与既有记录冲突时标记，交医护复核，不自动覆盖。

    四类判定：

    1. ``symptoms``：对话提到的症状落到某张量表关注面上，而该量表结果正常；
    2. ``complaint``：主诉里说过的症状，在后续对话里被明确否认；
    3. ``medication``：画像记录在用的药，对话里说已经停了；
    4. ``history``：画像里的既往史，对话里被明确否认。

    命中任意一类都只产出一条标记，**不修改任何一方的数据**，也不影响计分。
    宁可多报让医护看一眼，不可漏报让它静默过去。
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
                _flag(
                    "symptoms",
                    dialogue_value=overlap,
                    scale_value=f"{scale.get('scale_code')} 未提示异常",
                    note=(
                        f"对话提到「{'、'.join(overlap)}」，但 {scale.get('scale_code')} "
                        f"{scale.get('scale_name', '')} 结果为「{scale.get('level', '')}」，请医护复核。"
                    ),
                )
            )

    negated = {(item.get("kind"), item.get("ref")): item for item in (negations or []) if item.get("ref")}

    # 主诉与后续描述打架：一开始说的困扰，后面又说没有。
    complaint_codes = [code for code in (chief_complaint or {}).get("symptom_codes", []) or [] if code]
    for code in complaint_codes:
        hit = negated.get(("symptom", code))
        if not hit:
            continue
        flags.append(
            _flag(
                "complaint",
                dialogue_value=f"否认「{hit.get('term', code)}」",
                profile_value=f"主诉「{(chief_complaint or {}).get('text', '')}」",
                evidence=hit.get("evidence", ""),
                note=(
                    f"主诉是「{(chief_complaint or {}).get('text', '')}」，"
                    f"但后续对话说「{hit.get('evidence', '')}」，前后不一致，请医护复核。"
                ),
            )
        )

    # 用药：记录在吃，对话说停了。
    for name in profile_medications or []:
        hit = negated.get(("medication", name))
        if not hit:
            continue
        flags.append(
            _flag(
                "medication",
                dialogue_value=f"称已停用「{name}」",
                profile_value=f"用药记录：{name}",
                evidence=hit.get("evidence", ""),
                note=(
                    f"画像记录在服用「{name}」，但对话说「{hit.get('evidence', '')}」。"
                    f"停药与否必须由医生确认，请复核。"
                ),
            )
        )

    # 既往史：记录有病，对话否认。
    for name in profile_conditions or []:
        hit = negated.get(("condition", name))
        if not hit:
            continue
        flags.append(
            _flag(
                "history",
                dialogue_value=f"否认「{name}」",
                profile_value=f"既往史：{name}",
                evidence=hit.get("evidence", ""),
                note=(
                    f"既往史记录「{name}」，但对话说「{hit.get('evidence', '')}」，"
                    f"请医护核对是哪一方需要更正。"
                ),
            )
        )
    return flags


def build_messages(
    db: Session,
    patient_name: str,
    history: list[dict],
    user_text: str,
) -> tuple[list[dict[str, str]], str]:
    """构造对话消息。

    提示词优先取 `prompt_templates` 表里的生效版本（运营可改），
    表里没有则用代码内置版本；返回的版本号用于 `model_runs` 留痕。

    :return: ``(messages, 提示词版本号)``
    """
    fallback_system = (
        "你是老年人就医前预问诊助手。任务是用通俗、简短、关心的语气，围绕以下话题引导式提问："
        + "、".join(TOPIC_LIST)
        + "。每次只问一个问题。不得诊断、不得建议加药减药停药、不得承诺疗效。"
        "若老人描述急症表现，立即提示其立即就医并转人工。"
        "回答使用简体中文，不超过 80 字。"
    )
    system, version = resolve_prompt(
        db, PROMPT_CODE_DIALOGUE, fallback_system, DIALOGUE_PROMPT_VERSION
    )
    messages: list[dict[str, str]] = [{"role": "system", "content": system}]
    for turn in history[-6:]:
        messages.append({"role": turn.get("role", "user"), "content": turn.get("content", "")})
    messages.append({"role": "user", "content": user_text})
    return messages, version


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


# 模型没给出可用正文时的兜底（推理模型预算耗尽等）——不能编，也不能静默空回复。
# 退化为「请再说一遍」，既符合适老化，也符合「不臆断」红线。
FALLBACK_REPEAT = "抱歉，我没太听清您刚才说的，方便再说一遍吗？"
FALLBACK_NETWORK = "不好意思，这边网络不太顺，您稍后再试，或者先跟我再说一遍刚才的情况。"


@dataclass
class TurnContext:
    """一轮对话里「与模型无关」的那部分准备结果。

    拆出来的目的是让非流式与流式共用同一套准备与落库逻辑：两条路径只有
    「文本怎么产生」不同，抽取、安全提示、冲突标记、画像更新与留痕必须
    完全一致——否则同一句话走不同接口会得到不同结论。
    """

    session: DialogueSession
    user_text: str
    proxy: dict[str, Any]
    provider: Any
    messages: list[dict[str, str]]
    prompt_version: str
    model: str


def prepare_turn(
    db: Session,
    session: DialogueSession,
    user_text: str,
    proxy: dict | None = None,
) -> TurnContext:
    """组装历史、提示词与 Provider，供流式/非流式共用。"""
    history = [
        {"role": turn.role, "content": turn.content}
        for turn in db.query(DialogueTurn).filter(DialogueTurn.session_id == session.id).all()
    ]
    provider = get_provider()
    messages, prompt_version = build_messages(db, "老人", history, user_text)
    return TurnContext(
        session=session,
        user_text=user_text,
        proxy=proxy or {},
        provider=provider,
        messages=messages,
        prompt_version=prompt_version,
        model=getattr(provider, "model", "mock"),
    )


def finalize_turn(
    db: Session,
    ctx: TurnContext,
    reply: str,
    latency_ms: int,
    model_error: str = "",
    interrupted: bool = False,
) -> dict[str, Any]:
    """落库并组装响应体，流式与非流式共用，保证两边字段完全一致。

    :param interrupted: 回复没有走完（老人中途关掉页面、连接断开）。
        此时 ``reply`` 是**已经生成的那部分**，不补全、不润色，
        前端据此显示中断状态，医护也能看出这条不是完整回复。
    """
    extracted_symptoms = extract_symptoms(ctx.user_text)
    safety_note = check_safety(ctx.user_text) or check_safety(reply)

    # 冲突检测要拿「已有记录」比对，所以先读画像再更新画像，顺序不能倒。
    profile = _profile_of(db, ctx.session.patient_id)
    condition_names = _condition_names(profile)
    medication_names = _medication_names(profile)
    negations = extract_negations(
        ctx.user_text,
        condition_names=condition_names,
        medication_names=medication_names,
    )
    conflict_flags = detect_conflicts(
        extracted_symptoms,
        _latest_scale_results(db, ctx.session.patient_id),
        negations=negations,
        profile_conditions=condition_names,
        profile_medications=medication_names,
        chief_complaint=(profile.chief_complaint if profile else {}) or {},
    )

    db.add(
        DialogueTurn(
            session_id=ctx.session.id,
            role="user",
            content=ctx.user_text,
            extracted={"symptoms": extracted_symptoms, "proxy": ctx.proxy},
            safety_note=safety_note,
            conflict_flags=conflict_flags,
        )
    )
    db.add(
        DialogueTurn(
            session_id=ctx.session.id,
            role="assistant",
            content=reply,
            extracted={"interrupted": True} if interrupted else {},
            safety_note=safety_note,
        )
    )
    db.add(
        ModelRun(
            task="dialogue",
            model=ctx.model,
            prompt_version=ctx.prompt_version,
            latency_ms=latency_ms,
            input_snapshot={"user_text": ctx.user_text},
            output_snapshot={
                "reply": reply,
                **({"model_error": model_error} if model_error else {}),
                **({"interrupted": True} if interrupted else {}),
            },
        )
    )
    _update_profile(
        db,
        ctx.session.patient_id,
        extracted_symptoms,
        negated_codes={item["ref"] for item in negations if item.get("kind") == "symptom"},
        # 只有抽到症状的那句才配当主诉，「你好」不该成为「为什么来」
        chief_complaint_text=ctx.user_text if extracted_symptoms else "",
    )
    db.commit()

    return {
        "reply": reply,
        "extracted": {"symptoms": extracted_symptoms, "proxy": ctx.proxy},
        "safety_note": safety_note,
        "conflict_flags": conflict_flags,
        "disclaimer": SAFETY_DISCLAIMER,
        "model": ctx.model,
        "prompt_version": ctx.prompt_version,
        "interrupted": interrupted,
    }


def run_dialogue_turn(
    db: Session,
    session: DialogueSession,
    user_text: str,
    proxy: dict | None = None,
) -> dict[str, Any]:
    """执行一轮对话（非流式）：模型回复 + 抽取 + 安全提示 + 冲突标记 + 画像更新。"""
    ctx = prepare_turn(db, session, user_text, proxy)
    try:
        reply, latency = timed_chat(ctx.provider, ctx.messages)
        model_error = ""
    except LLMEmptyResponse as exc:
        reply = FALLBACK_REPEAT
        latency = 0
        model_error = str(exc)
    except Exception as exc:  # 网络异常、鉴权失败等
        reply = FALLBACK_NETWORK
        latency = 0
        model_error = f"{type(exc).__name__}: {exc}"
    return finalize_turn(db, ctx, reply, latency, model_error)


def _profile_of(db: Session, patient_id: int) -> PatientMedicalProfile | None:
    return (
        db.query(PatientMedicalProfile)
        .filter(PatientMedicalProfile.patient_id == patient_id)
        .first()
    )


def _as_name(item) -> str:
    """画像里的病史 / 用药既可能是字符串，也可能是 ``{"name": ...}``。

    契约写的是对象数组，但早期种子数据与部分导入脚本直接存字符串，
    两种都要读得出来，否则冲突检测会在历史数据上静默失效。
    """
    if isinstance(item, str):
        return item.strip()
    if isinstance(item, dict):
        return str(item.get("name") or "").strip()
    return ""


def _condition_names(profile: PatientMedicalProfile | None) -> list[str]:
    return [name for name in (_as_name(item) for item in (profile.conditions if profile else []) or []) if name]


def _medication_names(profile: PatientMedicalProfile | None) -> list[str]:
    return [name for name in (_as_name(item) for item in (profile.medications if profile else []) or []) if name]


def _update_profile(
    db: Session,
    patient_id: int,
    symptoms: list[dict],
    *,
    negated_codes: set[str] | None = None,
    chief_complaint_text: str = "",
) -> None:
    """把本轮抽到的症状并入专属画像。

    两处刻意的取舍：

    - **被明确否认的症状不入画像**。``extract_symptoms`` 只看词表命中，
      「我没有头晕」也会抽出 ``dizziness``；直接累积会让画像记下老人否认过的事，
      后续匹配与报告都跟着错。
    - **主诉只在首次写入**。主诉是「一开始为什么来」，被后续轮次改写就失去意义。
    """
    profile = (
        db.query(PatientMedicalProfile)
        .filter(PatientMedicalProfile.patient_id == patient_id)
        .first()
    )
    if profile is None:
        profile = PatientMedicalProfile(patient_id=patient_id, symptoms=[], conditions=[], medications=[], lifestyle={}, chief_complaint={})
        db.add(profile)
    denied = negated_codes or set()
    existing = {item.get("code") for item in (profile.symptoms or [])}
    for symptom in symptoms:
        code = symptom.get("code")
        if not code or code in existing or code in denied:
            continue
        profile.symptoms = list(profile.symptoms or []) + [symptom]
        existing.add(code)
    if chief_complaint_text and not (profile.chief_complaint or {}):
        profile.chief_complaint = {
            "text": chief_complaint_text,
            "symptom_codes": [item.get("code") for item in symptoms if item.get("code")],
            "onset": "",
            "site": "",
            "source": "dialogue",
        }
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
    fallback_system = (
        "你是老年综合评估的辅助分析助手。仅依据给定信息，按躯体功能、精神心理、社会与环境、"
        "老年综合征四个维度给出补充性结论与变化趋势。不得虚构未采集的内容，不得输出诊断，"
        "并标注信息来源为「AI 补充评估」。用简体中文，输出 JSON。"
    )
    system, prompt_version = resolve_prompt(
        db, PROMPT_CODE_PERIODIC, fallback_system, DIALOGUE_PROMPT_VERSION
    )
    messages = [
        {
            "role": "system",
            "content": system,
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
        prompt_version=prompt_version,
        input_snapshot={"symptoms": symptoms, "conditions": conditions},
        notice="AI 补充评估，不替代正式量表施测；与量表结果冲突时以人工复核为准。",
    )
    db.add(record)
    db.add(
        ModelRun(
            task="periodic_assessment",
            model=getattr(provider, "model", "mock"),
            prompt_version=prompt_version,
            latency_ms=latency,
            input_snapshot={"symptoms": symptoms},
            output_snapshot={"reply": reply[:500]},
        )
    )
    db.commit()
    return record
