"""症状—疾病综合匹配引擎。

流程（对应需求 §5.8）：
归一化 → 候选召回（症状倒排）→ 加权打分 → 同症多病鉴别 → Top-N 输出（匹配度 + 参考概率 + 依据）→ 阈值判定分级提醒。

- 「匹配度」= 0~100 的可解释规则分（命中症状加权得分 / 该病最高可能得分）
- 「参考概率」= 候选之间的归一化相对可能性（softmax），**不是**患病概率
- 至少返回 Top-3 候选；证据不足时降级提醒，不直接触发最高级别
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

from app.services.scales_store import symptom_term

DISCLAIMER = "结果仅供参考，不构成诊断，请及时咨询医生。"

LEVEL_LABELS = {
    "immediate": "立即就医",
    "urgent": "尽快就医",
    "elective": "择期就诊",
    "observe": "居家观察",
}

# 误报控制：核心症状命中数低于该值时，提醒等级下调一级
MIN_CORE_HITS_FOR_ALERT = 2


@dataclass
class MatchingWeights:
    core: float = 3.0
    secondary: float = 1.0
    history_bonus: float = 15.0
    temperature: float = 10.0
    global_threshold: float = 60.0
    top_n: int = 5

    def to_dict(self) -> dict[str, float]:
        return {
            "core": self.core,
            "secondary": self.secondary,
            "history_bonus": self.history_bonus,
            "temperature": self.temperature,
            "global_threshold": self.global_threshold,
        }


@dataclass
class MatchOutcome:
    candidates: list[dict] = field(default_factory=list)
    alert: dict = field(default_factory=dict)
    thresholds: dict = field(default_factory=dict)
    evidence: dict = field(default_factory=dict)


def _normalize_text(text: str) -> str:
    return (text or "").strip().lower().replace(" ", "")


def build_evidence(
    scale_flags: list[dict],
    dialogue_symptoms: list[dict],
    conditions: list[str],
) -> dict[str, Any]:
    """把量表阳性标记、对话抽取症状、既往病史汇总成证据集合。"""
    symptoms: dict[str, dict] = {}
    for flag in scale_flags:
        for code in flag.get("symptom_codes", []):
            entry = symptoms.setdefault(
                code, {"code": code, "term": symptom_term(code), "sources": [], "weight": "secondary"}
            )
            entry["sources"].append("scale")
    for item in dialogue_symptoms:
        code = item.get("code")
        if not code:
            continue
        entry = symptoms.setdefault(
            code, {"code": code, "term": symptom_term(code), "sources": [], "weight": "secondary"}
        )
        if "dialogue" not in entry["sources"]:
            entry["sources"].append("dialogue")
    return {
        "symptoms": list(symptoms.values()),
        "symptom_codes": set(symptoms.keys()),
        "conditions": [_normalize_text(c) for c in conditions if c],
    }


def _history_match(disease: dict, conditions: set[str]) -> bool:
    names = [disease.get("name", "")] + list(disease.get("aliases", []) or [])
    for name in names:
        normalized = _normalize_text(name)
        if not normalized:
            continue
        for condition in conditions:
            if normalized and (normalized == condition or normalized in condition or condition in normalized):
                return True
    return False


def run_matching(
    diseases: list[dict],
    evidence: dict,
    weights: MatchingWeights,
    thresholds: dict[str, float],
) -> MatchOutcome:
    """执行匹配，返回 Top-N 候选与分级提醒。"""
    symptom_codes: set[str] = evidence.get("symptom_codes", set())
    conditions: set[str] = evidence.get("conditions", set())

    scored: list[dict] = []
    for disease in diseases:
        payload = disease.get("payload") or disease
        symptom_list = payload.get("symptoms", []) or []
        if not symptom_list:
            continue
        hit: list[dict] = []
        missing: list[dict] = []
        raw = 0.0
        max_possible = 0.0
        core_hits = 0
        for symptom in symptom_list:
            code = symptom.get("code", "")
            weight = symptom.get("weight", "secondary")
            score = weights.core if weight == "core" else weights.secondary
            max_possible += score
            if code in symptom_codes:
                raw += score
                if weight == "core":
                    core_hits += 1
                hit.append({"code": code, "term": symptom_term(code), "weight": weight, "points": score})
            else:
                missing.append({"code": code, "term": symptom_term(code), "weight": weight})

        history_hit = _history_match(disease, conditions)
        if history_hit:
            raw += weights.history_bonus
            matched_names = [
                condition
                for condition in conditions
                if any(
                    _normalize_text(alias) in condition or condition in _normalize_text(alias)
                    for alias in [disease.get("name", "")] + list(disease.get("aliases", []) or [])
                    if _normalize_text(alias)
                )
            ]
            hit.append(
                {
                    "code": f"history:{disease.get('code', '')}",
                    "term": "既往病史：" + "、".join(matched_names or [disease.get("name", "")]),
                    "weight": "history",
                    "points": weights.history_bonus,
                }
            )

        # 同症多病鉴别：缺少鉴别特征时扣分（扣分不超过命中得分的 50%，避免把证据完全抹掉）
        excluded: list[dict] = []
        penalty_total = 0.0
        for differential in payload.get("differentials", []) or []:
            features = differential.get("features", []) or []
            if features and not any(feature in symptom_codes for feature in features):
                points = float(differential.get("points", 0) or 0)
                if points < 0:
                    penalty_total += points
                excluded.append(
                    {
                        "vs_code": differential.get("vs_code", ""),
                        "reason": differential.get("reason", ""),
                        "points": points,
                    }
                )
        capped_penalty = max(penalty_total, -raw * 0.5) if raw > 0 else 0.0
        if capped_penalty != penalty_total:
            excluded.append(
                {
                    "vs_code": "",
                    "reason": "鉴别扣分已按命中得分的 50% 封顶，保留证据可见性",
                    "points": round(capped_penalty - penalty_total, 2),
                }
            )
        raw = raw + capped_penalty

        match_score = 0.0 if max_possible <= 0 else max(0.0, min(100.0, raw / max_possible * 100.0))
        scored.append(
            {
                "disease_code": disease.get("code", ""),
                "disease_name": disease.get("name", ""),
                "system": disease.get("system", ""),
                "risk_level": payload.get("risk_level", "observe"),
                "raw_score": round(raw, 2),
                "match_score": round(match_score, 2),
                "hit_symptoms": hit,
                "missing_symptoms": missing,
                "excluded_reasons": excluded,
                "core_hits": core_hits,
                "history_hit": history_hit,
                "advice": payload.get("advice", {}),
                "review_status": disease.get("review_status", "draft_pending_medical_review"),
                "evidence_insufficient": False,
            }
        )

    scored.sort(key=lambda item: item["raw_score"], reverse=True)

    # 参考概率：softmax 归一化（相对可能性，不是患病概率）
    temperature = max(weights.temperature, 0.1)
    positives = [item for item in scored if item["raw_score"] > 0]
    if positives:
        max_raw = max(item["raw_score"] for item in positives)
        exps = {item["disease_code"]: math.exp((item["raw_score"] - max_raw) / temperature) for item in positives}
        total = sum(exps.values()) or 1.0
        for item in scored:
            item["ref_probability"] = round(exps.get(item["disease_code"], 0.0) / total * 100.0, 2)
    else:
        for item in scored:
            item["ref_probability"] = 0.0

    candidates = [item for item in scored if item["raw_score"] > 0][: weights.top_n]

    # 至少返回 Top-3：证据不足时用库内其它疾病补位并标注证据不足
    if len(candidates) < 3:
        seen = {item["disease_code"] for item in candidates}
        for item in scored:
            if len(candidates) >= 3:
                break
            if item["disease_code"] in seen:
                continue
            padded = dict(item)
            padded["evidence_insufficient"] = True
            padded["match_score"] = 0.0
            padded["ref_probability"] = 0.0
            candidates.append(padded)
            seen.add(item["disease_code"])

    for rank, item in enumerate(candidates, start=1):
        item["rank"] = rank

    alert = _decide_alert(candidates, thresholds, weights)
    return MatchOutcome(
        candidates=candidates,
        alert=alert,
        thresholds=dict(thresholds),
        evidence={"symptom_codes": sorted(symptom_codes), "conditions": sorted(conditions)},
    )


def _decide_alert(candidates: list[dict], thresholds: dict[str, float], weights: MatchingWeights) -> dict:
    """分级提醒判定，含误报控制。"""
    global_threshold = float(thresholds.get("global", weights.global_threshold))
    if not candidates:
        return {
            "level": "observe",
            "level_label": LEVEL_LABELS["observe"],
            "message": "本次未匹配到明显风险，纳入随访观察，下次评估重点跟踪。",
            "department": "",
            "disclaimer": DISCLAIMER,
            "triggered": False,
            "threshold": global_threshold,
        }

    top = candidates[0]
    threshold = float(thresholds.get(top["disease_code"], global_threshold))
    level = "observe"
    if top["match_score"] >= threshold:
        level = top.get("risk_level", "urgent")
    if level == "observe" and top["match_score"] >= threshold * 0.8:
        level = "elective"

    # 误报控制：核心症状证据不足 → 降级一级
    if level in {"immediate", "urgent", "elective"}:
        insufficient = top.get("evidence_insufficient") or top.get("core_hits", 0) < MIN_CORE_HITS_FOR_ALERT
        if insufficient:
            level = {"immediate": "urgent", "urgent": "elective", "elective": "observe"}.get(level, level)
            downgrade_reason = "核心症状证据不足，提醒等级已下调一级"
        else:
            downgrade_reason = ""
    else:
        downgrade_reason = ""

    advice = top.get("advice") or {}
    department = advice.get("department", "")
    message = advice.get("text") or f"本次评估提示需要关注「{top['disease_name']}」，建议尽快到{department or '相关科室'}就诊。"
    if downgrade_reason:
        message = f"{message}（{downgrade_reason}）"

    return {
        "level": level,
        "level_label": LEVEL_LABELS.get(level, "居家观察"),
        "message": message,
        "department": department,
        "disclaimer": DISCLAIMER,
        "triggered": level in {"immediate", "urgent"},
        "threshold": threshold,
        "top_disease": top["disease_name"],
        "match_score": top["match_score"],
        "ref_probability": top["ref_probability"],
    }
