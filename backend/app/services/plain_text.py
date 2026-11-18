"""题目口语化改写与审批回写（A-4）。

设计上有一条硬线：**候选不直接覆盖已评审的 `plain_text`**。

题库里 127 道题的 `plain_text` 已经过评审，是基线。改写接口产出的是候选，
先落在 `payload.plain_text_draft` 里等审批，审批通过才提升为 `plain_text`。
这样「机器改一版就直接上线」这条路在结构上不存在，不靠人记着别点错。

另一个约束是计分：改写只碰展示文案，`code` / `options` / `score` /
`when` / `measure` 一律不动。题号与计分绑定关系是量表可回溯的前提。
"""

from __future__ import annotations

import datetime as dt
import re
from functools import lru_cache
from typing import Any

from sqlalchemy.orm import Session

from app.db.models import ScaleTemplate, ScaleVersion, TemplateApproval, User
from app.services import scale_review
from app.services.scales_store import get_scale, load_symptoms

#: 保守的书面语 → 口语替换。只做**同义通俗化**，不涉及任何医学判断。
COLLOQUIAL_MAP: list[tuple[str, str]] = [
    ("是否", "是不是"),
    ("有无", "有没有"),
    ("能否", "能不能"),
    ("既往", "以前"),
    ("服药", "吃药"),
    ("用药", "吃药"),
    ("食量", "饭量"),
    ("食欲", "胃口"),
    ("排便", "解大便"),
    ("排尿", "解小便"),
    ("行走", "走路"),
    ("跌倒", "摔倒"),
    ("体重下降", "体重减轻"),
    ("睡眠障碍", "睡觉不好"),
    ("情绪低落", "心情不好"),
    ("日常活动", "平时的活动"),
    ("自理能力", "自己照顾自己"),
]

MAX_PLAIN_TEXT = 120
MIN_PLAIN_TEXT = 4

_REWRITE_SYSTEM = (
    "你是老年综合评估系统的文案助手，负责把量表题干改写为老年人能听懂的口语提问。\n"
    "硬性要求：\n"
    "1. 只改表达方式，不得改变任何医学含义；\n"
    "2. 不得增加或删除症状、部位、时间、频率、程度等信息；\n"
    "3. 不得给建议、不得解释疾病、不得使用专业术语；\n"
    "4. 一句话，不超过 30 个汉字，用「您」称呼；\n"
    "5. 只输出改写后的这一句话，不要解释、不要引号、不要编号。"
)


@lru_cache(maxsize=1)
def _symptom_index() -> tuple[tuple[str, str], ...]:
    """(可匹配词, 症状 code)，按词长倒序。"""
    table = load_symptoms()
    items: list[tuple[str, str]] = []
    for code, entry in table.items():
        items.append((entry.get("term", code), code))
        for synonym in entry.get("synonyms", []) or []:
            items.append((synonym, code))
    items.sort(key=lambda pair: len(pair[0]), reverse=True)
    return tuple(items)


def symptom_codes(text: str) -> set[str]:
    """文本里出现的受控症状词（用于「改写是否引入新症状」的护栏）。"""
    found: set[str] = set()
    if not text:
        return found
    for term, code in _symptom_index():
        if term and term in text:
            found.add(code)
    return found


def rule_rewrite(text: str) -> str:
    """规则改写（mock / 离线环境下使用，确定性输出）。

    只做同义通俗化与语序调整，不生成新内容——离线状态下也要保证
    「改写不会悄悄改掉医学含义」这条底线成立。
    """
    result = (text or "").strip()
    if not result:
        return ""
    for formal, spoken in COLLOQUIAL_MAP:
        result = result.replace(formal, spoken)
    if result.endswith("？") or result.endswith("?"):
        return result
    if result.endswith("。"):
        result = result[:-1]
    # 题干多为短语（如「进食」「洗澡」），补成完整问句，而不是原样加问号。
    if len(result) <= 6 and not re.search(r"[吗呢？?]", result):
        return f"您{result}这件事，自己能做吗？"
    if re.search(r"[吗呢]", result):
        return f"{result}？"
    return f"请问，{result}？"


def build_messages(question: dict[str, Any]) -> list[dict[str, str]]:
    source = (question.get("text") or "").strip()
    current = (question.get("plain_text") or "").strip()
    user = f"原题干：{source}\n现有口语版：{current or '（无）'}"
    return [
        {"role": "system", "content": _REWRITE_SYSTEM},
        {"role": "user", "content": user},
    ]


def guard(source: str, candidate: str) -> list[str]:
    """自动护栏：把「改写引入了新症状」这类问题在审批前就标出来。

    不做拦截，只提示——最终判断必须是人做的。但没有这条提示，
    审批人很难从一句通顺的口语里看出「多了个症状」。
    """
    notes: list[str] = []
    text = (candidate or "").strip()
    if not text:
        notes.append("候选为空")
        return notes
    if len(text) < MIN_PLAIN_TEXT:
        notes.append(f"候选过短（少于 {MIN_PLAIN_TEXT} 字），可能丢失题干信息")
    if len(text) > MAX_PLAIN_TEXT:
        notes.append(f"候选过长（超过 {MAX_PLAIN_TEXT} 字），老人端一屏放不下")
    if "\n" in text:
        notes.append("候选含换行，老人端会拆成多段")
    if re.search(r"[A-Za-z]{3,}", text):
        notes.append("候选含英文词，老人端不宜出现")
    added = symptom_codes(text) - symptom_codes(source)
    if added:
        names = "、".join(sorted(added))
        notes.append(f"候选引入了原题干没有的症状词：{names}，需确认是否改变题意")
    dropped = symptom_codes(source) - symptom_codes(text)
    if dropped:
        names = "、".join(sorted(dropped))
        notes.append(f"候选漏掉了原题干的症状词：{names}，需确认是否丢失信息")
    return notes


def _question_index(scale: dict) -> dict[str, dict]:
    index: dict[str, dict] = {}
    for section in scale.get("sections") or []:
        for question in section.get("questions") or []:
            code = question.get("code")
            if code:
                index[code] = question
    return index


def _find_section(scale: dict, question_code: str) -> dict | None:
    for section in scale.get("sections") or []:
        for question in section.get("questions") or []:
            if question.get("code") == question_code:
                return section
    return None


def generate_candidates(
    db: Session,
    *,
    code: str,
    question_codes: list[str] | None = None,
    provider: Any = None,
) -> dict:
    """生成改写候选并落进 `plain_text_draft`（不覆盖已评审文案）。"""
    row = db.query(ScaleTemplate).filter(ScaleTemplate.code == code).first()
    if row is None:
        raise ValueError(f"量表不存在：{code}")
    scale = get_scale(db, code) or {}
    index = _question_index(scale)
    targets = [item for item in (question_codes or list(index)) if item in index]
    if not targets:
        raise ValueError("没有可改写的题目：请检查题目编号")

    payload = dict(row.payload or {})
    sections = [dict(section) for section in payload.get("sections") or []]
    draft_map: dict[str, dict] = dict(payload.get("plain_text_draft") or {})
    model_name = getattr(provider, "model", "") or "rule-colloquial-v1"
    now = dt.datetime.now(dt.timezone.utc).isoformat()

    produced: list[dict] = []
    for section in sections:
        questions = []
        for question in section.get("questions") or []:
            item = dict(question)
            qcode = item.get("code")
            if qcode in targets:
                source = (item.get("text") or "").strip()
                if provider is not None and getattr(provider, "name", "") != "mock":
                    try:
                        raw = provider.chat(build_messages(item), temperature=0.2, max_tokens=200)
                        candidate = (raw or "").strip().strip("“”\"'")
                    except Exception:
                        # 模型不可用时退回规则改写，宁可产出朴素结果，也不要中断整批。
                        candidate = rule_rewrite(source)
                        model_name = "rule-colloquial-v1"
                else:
                    candidate = rule_rewrite(source)
                notes = guard(source, candidate)
                entry = {
                    "question_code": qcode,
                    "source_text": source,
                    "current_plain_text": (item.get("plain_text") or "").strip(),
                    "candidate": candidate,
                    "risk_notes": notes,
                    "model": model_name,
                    "generated_at": now,
                }
                draft_map[qcode] = entry
                produced.append(entry)
            questions.append(item)
        section["questions"] = questions
    payload["sections"] = sections
    payload["plain_text_draft"] = draft_map
    row.payload = payload
    db.commit()
    return {"code": code, "model": model_name, "count": len(produced), "items": produced}


def apply_candidates(
    db: Session,
    *,
    code: str,
    items: list[dict],
    reviewer_name: str,
    reviewer_title: str,
    evidence_type: str,
    comment: str,
    reviewed_at: Any,
    actor: User | None,
) -> dict:
    """审批通过后把候选提升为 `plain_text`，并留版本与审批记录。"""
    row = db.query(ScaleTemplate).filter(ScaleTemplate.code == code).first()
    if row is None:
        raise ValueError(f"量表不存在：{code}")
    if not items:
        raise ValueError("没有要回写的题目")

    signed = scale_review.validate_evidence(
        reviewer_name=reviewer_name,
        reviewer_title=reviewer_title,
        evidence_type=evidence_type,
        comment=comment,
        reviewed_at=reviewed_at,
        actor=actor,
        require_title=True,
        require_date=True,
    )

    payload = dict(row.payload or {})
    sections = [dict(section) for section in payload.get("sections") or []]
    index = {code_: q for section in sections for q in (section.get("questions") or []) if (code_ := q.get("code"))}
    accepted: list[dict] = []
    rejected: list[dict] = []
    for item in items:
        qcode = (item.get("question_code") or "").strip()
        text = (item.get("plain_text") or "").strip()
        if qcode not in index:
            rejected.append({"question_code": qcode, "reason": "题目编号不存在"})
            continue
        if not text:
            rejected.append({"question_code": qcode, "reason": "文案为空"})
            continue
        source = (index[qcode].get("text") or "").strip()
        notes = guard(source, text)
        blocking = [n for n in notes if "症状词" in n]
        if blocking:
            rejected.append({"question_code": qcode, "reason": "；".join(blocking)})
            continue
        accepted.append({"question_code": qcode, "plain_text": text, "notes": notes})

    if not accepted:
        # 把首条原因带出来：只说「没有一条通过」等于让人自己去猜，
        # 而这里拦下的恰恰是「多了症状词」这种不容易一眼看出的事。
        first = rejected[0]["reason"] if rejected else "未知原因"
        raise ValueError(f"没有一条候选通过护栏检查，请先处理提示项（{rejected[0]['question_code']}：{first}）")

    applied_at = dt.datetime.now(dt.timezone.utc).isoformat()
    accepted_map = {item["question_code"]: item for item in accepted}
    for section in sections:
        questions = []
        for question in section.get("questions") or []:
            item = dict(question)
            hit = accepted_map.get(item.get("code"))
            if hit:
                item["plain_text"] = hit["plain_text"]
                item["plain_text_meta"] = {
                    "reviewer": signed["reviewer_name"],
                    "reviewer_title": signed["reviewer_title"],
                    "evidence": signed["evidence"],
                    "reviewed_at": signed["reviewed_at"].isoformat() if signed["reviewed_at"] else "",
                    "applied_at": applied_at,
                    "guard_notes": hit["notes"],
                }
            questions.append(item)
        section["questions"] = questions
    payload["sections"] = sections
    draft_map = dict(payload.get("plain_text_draft") or {})
    for item in accepted:
        draft_map.pop(item["question_code"], None)
    payload["plain_text_draft"] = draft_map
    row.payload = payload

    db.add(
        ScaleVersion(
            scale_code=code,
            version=row.version,
            payload={"changed_questions": [item["question_code"] for item in accepted]},
            reviewer=signed["reviewer_name"],
            comment=f"口语化文案回写：{len(accepted)} 题（{signed['evidence']}）",
            created_by=actor.id if actor else None,
        )
    )
    db.add(
        TemplateApproval(
            target_type="scale_plain_text",
            target_id=code,
            action="approved",
            reviewer=signed["reviewer_name"],
            reviewer_title=signed["reviewer_title"],
            evidence_type=signed["evidence"],
            operator=(actor.full_name or actor.username) if actor else "",
            reviewed_at=signed["reviewed_at"],
            comment=signed["comment"],
        )
    )
    db.commit()
    return {
        "code": code,
        "applied": len(accepted),
        "rejected": rejected,
        "items": accepted,
        "review": {
            "reviewer": signed["reviewer_name"],
            "reviewer_title": signed["reviewer_title"],
            "evidence": signed["evidence"],
            "evidence_label": scale_review.evidence_label(signed["evidence"]),
            "reviewed_at": signed["reviewed_at"].isoformat() if signed["reviewed_at"] else "",
        },
    }


def draft_status(db: Session, code: str) -> dict:
    """当前的候选池（供审批前查看）。"""
    row = db.query(ScaleTemplate).filter(ScaleTemplate.code == code).first()
    if row is None:
        raise ValueError(f"量表不存在：{code}")
    draft = (row.payload or {}).get("plain_text_draft") or {}
    return {"code": code, "count": len(draft), "items": list(draft.values())}
