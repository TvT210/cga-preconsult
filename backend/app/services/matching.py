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

from app.services.disease_library import symptom_probe, symptom_term

DISCLAIMER = "结果仅供参考，不构成诊断，请及时咨询医生。"

LEVEL_LABELS = {
    "immediate": "立即就医",
    "urgent": "尽快就医",
    "elective": "择期就诊",
    "observe": "居家观察",
}

# 提醒等级顺序（用于红旗征托底与降级比较）
LEVEL_ORDER = {"observe": 0, "elective": 1, "urgent": 2, "immediate": 3}

# 误报控制：核心症状命中数低于该值时，提醒等级下调一级
MIN_CORE_HITS_FOR_ALERT = 2


@dataclass
class MatchingWeights:
    core: float = 3.0
    secondary: float = 1.0
    history_bonus: float = 15.0
    protective_penalty: float = 2.0
    temperature: float = 10.0
    global_threshold: float = 60.0
    top_n: int = 5
    # 区分度加权：共享症状（很多病都有）权重下调，独有症状上调
    distinctive_weighting: bool = True
    idf_floor: float = 0.5
    idf_cap: float = 2.0
    # 症状组合命中时的额外加分（以一个核心症状的权重量级计）
    pattern_bonus: float = 3.0

    def to_dict(self) -> dict[str, float]:
        return {
            "core": self.core,
            "secondary": self.secondary,
            "history_bonus": self.history_bonus,
            "protective_penalty": self.protective_penalty,
            "temperature": self.temperature,
            "global_threshold": self.global_threshold,
            "distinctive_weighting": self.distinctive_weighting,
            "idf_floor": self.idf_floor,
            "idf_cap": self.idf_cap,
            "pattern_bonus": self.pattern_bonus,
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
    extracted_symptoms: list[dict],
    conditions: list[str],
) -> dict[str, Any]:
    """把量表阳性标记、抽取症状、既往病史汇总成证据集合。

    extracted_symptoms 元素需带 `source`（dialogue / preconsult），用于前端区分证据来源。
    """
    symptoms: dict[str, dict] = {}
    for flag in scale_flags:
        for code in flag.get("symptom_codes", []):
            entry = symptoms.setdefault(
                code, {"code": code, "term": symptom_term(code), "sources": [], "weight": "secondary"}
            )
            entry["sources"].append("scale")
    for item in extracted_symptoms:
        code = item.get("code")
        if not code:
            continue
        source = item.get("source", "dialogue")
        entry = symptoms.setdefault(
            code, {"code": code, "term": symptom_term(code), "sources": [], "weight": "secondary"}
        )
        if source not in entry["sources"]:
            entry["sources"].append(source)
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


def _document_frequency(diseases: list[dict]) -> dict[str, int]:
    """统计每个症状出现在多少个病种里（区分度的分母）。"""
    counter: dict[str, int] = {}
    for disease in diseases:
        payload = disease.get("payload") or disease
        codes = {item.get("code", "") for item in payload.get("symptoms", []) or []}
        for code in codes:
            if code:
                counter[code] = counter.get(code, 0) + 1
    return counter


def _idf_multiplier(code: str, df: dict[str, int], total: int, floor: float, cap: float) -> float:
    """区分度系数：出现在越多病种的症状，权重越低。

    命中 1 个病种 → cap（2.0，独有症状，说明力强）；
    命中全部病种 → floor（0.5，共享症状，说明力弱）。
    """
    if total <= 0:
        return 1.0
    seen = df.get(code, 0)
    if seen <= 0:
        return cap
    raw = math.log(1 + total / seen)
    normalized = raw / math.log(1 + total)
    return max(floor, min(cap, normalized * cap))


def _annotate_distinctiveness(candidates: list[dict]) -> None:
    """标注区分性症状与共享症状，回答「为什么是它而不是别的」。

    同一症状若被多个候选同时命中，说明该症状区分度低（很多病都有）；
    只被本候选命中，则是该病的区分性线索。
    """
    owners: dict[str, list[str]] = {}
    for candidate in candidates:
        for item in candidate.get("hit_symptoms", []):
            code = item.get("code", "")
            if not code or code.startswith(("history:", "pattern:")):
                continue
            owners.setdefault(code, []).append(candidate["disease_code"])

    for candidate in candidates:
        distinctive: list[dict] = []
        shared: list[dict] = []
        for item in candidate.get("hit_symptoms", []):
            code = item.get("code", "")
            if not code or code.startswith(("history:", "pattern:")):
                continue
            others = [owner for owner in owners.get(code, []) if owner != candidate["disease_code"]]
            if others:
                item["shared_with"] = others
                shared.append(
                    {
                        "code": code,
                        "term": item.get("term", code),
                        "shared_with": others,
                        "probe": symptom_probe(code),
                        "note": f"该症状在 {len(others) + 1} 个候选中同时出现，区分度低",
                    }
                )
            else:
                distinctive.append(
                    {
                        "code": code,
                        "term": item.get("term", code),
                        "weight": item.get("weight"),
                        "distinctive": item.get("distinctive"),
                        "probe": symptom_probe(code),
                        "note": "仅本候选命中，是支持本病的关键线索",
                    }
                )
        candidate["distinctive_symptoms"] = distinctive
        candidate["shared_symptoms"] = shared


def run_matching(
    diseases: list[dict],
    evidence: dict,
    weights: MatchingWeights,
    thresholds: dict[str, float],
) -> MatchOutcome:
    """执行匹配，返回 Top-N 候选与分级提醒。"""
    symptom_codes: set[str] = evidence.get("symptom_codes", set())
    conditions: set[str] = evidence.get("conditions", set())

    # 区分度系数：共享症状（很多病都有）权重下调，独有症状上调
    df = _document_frequency(diseases)
    total_diseases = len(diseases)

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
            base = weights.core if weight == "core" else weights.secondary
            multiplier = (
                _idf_multiplier(code, df, total_diseases, weights.idf_floor, weights.idf_cap)
                if weights.distinctive_weighting
                else 1.0
            )
            score = base * multiplier
            max_possible += score
            if code in symptom_codes:
                raw += score
                if weight == "core":
                    core_hits += 1
                hit.append(
                    {
                        "code": code,
                        "term": symptom_term(code),
                        "weight": weight,
                        "points": round(score, 2),
                        "distinctive": round(multiplier, 2),
                        "shared_with": [],
                    }
                )
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

        # 同症多病鉴别：缺少鉴别特征时扣分
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

        # 保护性征象：命中则直接削弱本病可能（比鉴别扣分更直接）
        protective_hits = [
            item
            for item in payload.get("protective_signs", []) or []
            if item.get("code") in symptom_codes
        ]
        for item in protective_hits:
            points = -weights.protective_penalty
            penalty_total += points
            excluded.append(
                {
                    "vs_code": "",
                    "reason": f"出现保护性征象「{item.get('term', '')}」：{item.get('note', '')}",
                    "points": points,
                }
            )

        # 扣分封顶：不超过命中得分的 50%，避免把已有证据完全抹掉
        capped_penalty = max(penalty_total, -raw * 0.5) if raw > 0 else 0.0
        if capped_penalty != penalty_total:
            excluded.append(
                {
                    "vs_code": "",
                    "reason": "鉴别与保护征象扣分已按命中得分的 50% 封顶，保留证据可见性",
                    "points": round(capped_penalty - penalty_total, 2),
                }
            )
        raw = raw + capped_penalty

        # 红旗征：命中即高度提示急症，提醒等级不得被降级
        red_flag_hits = [
            item for item in payload.get("red_flags", []) or [] if item.get("code") in symptom_codes
        ]

        # 高危因素：条目带 code 且命中时，标记为该老人已具备的高危因素
        risk_factor_hits = [
            item
            for item in payload.get("risk_factors", []) or []
            if item.get("code") and item.get("code") in symptom_codes
        ]

        # 症状组合模式：医生看的是「组合」而非单个症状，组合全中额外加分
        pattern_hits: list[dict] = []
        for pattern in payload.get("patterns", []) or []:
            codes = [code for code in pattern.get("symptoms", []) or [] if code]
            if len(codes) < 2:
                continue
            if all(code in symptom_codes for code in codes):
                bonus = float(pattern.get("bonus", weights.pattern_bonus) or 0)
                raw += bonus
                pattern_hits.append(
                    {
                        "code": f"pattern:{disease.get('code', '')}:{len(codes)}",
                        "term": pattern.get("note", "症状组合命中"),
                        "weight": "pattern",
                        "points": bonus,
                        "symptoms": codes,
                    }
                )

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
                "pattern_hits": pattern_hits,
                "missing_symptoms": missing,
                "excluded_reasons": excluded,
                "red_flags": red_flag_hits,
                "protective_signs": protective_hits,
                "risk_factor_hits": risk_factor_hits,
                "risk_factors": payload.get("risk_factors", []),
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

    _annotate_distinctiveness(candidates)

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

    # 红旗征托底：命中即高度提示急症，提醒等级不得低于 urgent（病种本身为急症则直接 immediate）
    red_flags = top.get("red_flags") or []
    upgrade_reason = ""
    if red_flags:
        floor = "immediate" if top.get("risk_level") == "immediate" else "urgent"
        if LEVEL_ORDER.get(level, 0) < LEVEL_ORDER.get(floor, 0):
            upgrade_reason = f"命中急症红旗征，提醒等级提升为「{LEVEL_LABELS[floor]}」"
            level = floor

    # 误报控制：核心症状证据不足 → 降级一级；但命中红旗征时不得降级
    if level in {"immediate", "urgent", "elective"}:
        insufficient = top.get("evidence_insufficient") or top.get("core_hits", 0) < MIN_CORE_HITS_FOR_ALERT
        if insufficient and not red_flags:
            level = {"immediate": "urgent", "urgent": "elective", "elective": "observe"}.get(level, level)
            downgrade_reason = "核心症状证据不足，提醒等级已下调一级"
        elif insufficient and red_flags:
            downgrade_reason = "核心症状证据不足，但命中红旗征，提醒等级不予下调"
        else:
            downgrade_reason = ""
    else:
        downgrade_reason = ""

    advice = top.get("advice") or {}
    department = advice.get("department", "")
    message = advice.get("text") or f"本次评估提示需要关注「{top['disease_name']}」，建议尽快到{department or '相关科室'}就诊。"
    if red_flags:
        flag_text = "、".join(item.get("term", "") for item in red_flags if item.get("term"))
        message = f"命中急症红旗征（{flag_text}）。{message}"
    if upgrade_reason:
        message = f"{message}（{upgrade_reason}）"
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
        "red_flags": red_flags,
    }
