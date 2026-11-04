"""自动计分与判读引擎。

两阶段设计：
1. `score` 阶段算出分值（sum / count_positive / max）；
2. `levels` 阶段把分值映射为等级与判读结论；`flags` 阶段给出阳性标记与症状映射。

每个结论都记录 `rule_refs`（题目 → 取值 → 分值 → 规则条目），可回溯到作答与规则，
满足「规则可解释」「结论可回溯到题目与规则条目」要求。
缺项或超范围时标记 `needs_manual_review`，不强行出结论。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from app.services.scales_store import symptom_term


@dataclass
class AnswerRecord:
    value: str = ""
    score: float | None = None
    measured: float | None = None
    skipped: bool = False
    skip_reason: str = ""
    proxy_flag: bool = False
    answered_by: str = ""

    @property
    def present(self) -> bool:
        return not self.skipped and (self.value != "" or self.score is not None)


@dataclass
class Evaluation:
    scale_code: str
    total: float = 0.0
    level: str = ""
    interpretation: str = ""
    abnormal: bool = False
    severity: str = "none"
    flags: list[dict] = field(default_factory=list)
    explanation: str = ""
    rule_refs: list[dict] = field(default_factory=list)
    missing_items: list[str] = field(default_factory=list)
    needs_manual_review: bool = False
    notices: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "scale_code": self.scale_code,
            "total": self.total,
            "level": self.level,
            "interpretation": self.interpretation,
            "abnormal": self.abnormal,
            "severity": self.severity,
            "flags": self.flags,
            "explanation": self.explanation,
            "rule_refs": self.rule_refs,
            "missing_items": self.missing_items,
            "needs_manual_review": self.needs_manual_review,
            "notices": self.notices,
        }


def _as_float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def evaluate_condition(condition: dict, answers: dict[str, AnswerRecord]) -> bool:
    """条件求值。

    - `eq` / `ne` / `in` 比较所选选项的 value 字符串；
    - `lt` / `lte` / `gt` / `gte` 比较所选选项的 score 数值。
    """
    answer = answers.get(condition.get("question", ""))
    if answer is None or answer.skipped:
        return False
    op = condition.get("op", "eq")
    value = condition.get("value")
    if op in {"eq", "ne", "in"}:
        actual = answer.value
        if op == "eq":
            return actual == value
        if op == "ne":
            return actual != value
        if isinstance(value, (list, tuple)):
            return actual in value
        return False
    score = answer.score
    if score is None:
        score = _as_float(actual_value(answer))
    if score is None:
        return False
    if op == "lt":
        return score < float(value)
    if op == "lte":
        return score <= float(value)
    if op == "gt":
        return score > float(value)
    if op == "gte":
        return score >= float(value)
    return False


def actual_value(answer: AnswerRecord) -> str:
    return answer.value


def evaluate_conditions(group: dict, answers: dict[str, AnswerRecord]) -> bool:
    if "any" in group:
        return any(evaluate_condition(item, answers) for item in group.get("any", []))
    if "all" in group:
        return all(evaluate_condition(item, answers) for item in group.get("all", []))
    return False


def _collect_items(scale: dict) -> list[dict]:
    scoring = scale.get("scoring") or {}
    score_rule = scoring.get("score") or {}
    return list((score_rule.get("config") or {}).get("items") or [])


def _question_map(scale: dict) -> dict[str, dict]:
    table: dict[str, dict] = {}
    for section in scale.get("sections", []):
        for question in section.get("questions", []):
            table[question.get("code", "")] = question
    return table


def evaluate_scale(scale: dict, answers: dict[str, AnswerRecord]) -> Evaluation:
    """对一份量表作答执行计分与判读。"""
    code = scale.get("code", "")
    result = Evaluation(scale_code=code)
    scoring = scale.get("scoring") or {}
    score_rule = scoring.get("score") or {}
    rule_type = score_rule.get("rule_type", "sum")
    config = score_rule.get("config") or {}
    items = _collect_items(scale)
    question_table = _question_map(scale)

    if not items:
        result.notices.append("题库条目待以标准原文补录，暂不产生判读结论")
        result.needs_manual_review = True
        return result

    detail_refs: list[dict] = []
    total = 0.0
    counted = 0
    missing: list[str] = []

    for item in items:
        item_code = item.get("code", "")
        label = item.get("label") or question_table.get(item_code, {}).get("text", item_code)
        max_score = _as_float(item.get("max_score"))
        answer = answers.get(item_code)
        if answer is None or not answer.present:
            missing.append(f"{item_code} {label}")
            continue
        if rule_type == "count_positive":
            mode = config.get("mode", "score_positive")
            hit = False
            if mode == "max_score_equals":
                hit = max_score is not None and answer.score is not None and abs(answer.score - max_score) < 1e-9
            else:
                hit = bool(answer.score and answer.score > 0)
            counted += 1 if hit else 0
            total = float(counted)
            detail_refs.append(
                {
                    "question": item_code,
                    "label": label,
                    "value": answer.value,
                    "score": answer.score,
                    "max_score": max_score,
                    "counted": hit,
                    "answered_by": answer.answered_by,
                    "proxy_flag": answer.proxy_flag,
                }
            )
        else:
            score = answer.score if answer.score is not None else 0.0
            total += score
            counted += 1
            detail_refs.append(
                {
                    "question": item_code,
                    "label": label,
                    "value": answer.value,
                    "score": answer.score,
                    "max_score": max_score,
                    "answered_by": answer.answered_by,
                    "proxy_flag": answer.proxy_flag,
                }
            )

    result.total = round(total, 2)
    result.missing_items = missing
    result.rule_refs.append(
        {
            "rule": f"score:{rule_type}",
            "config": config,
            "answered_count": counted,
            "total_count": len(items),
            "items": detail_refs,
            "explanation": score_rule.get("explanation", ""),
        }
    )

    # 判级
    levels_rule = scoring.get("levels") or {}
    levels = (levels_rule.get("config") or {}).get("levels") or []
    for level in levels:
        low = _as_float(level.get("min"))
        high = _as_float(level.get("max"))
        if (low is None or result.total >= low) and (high is None or result.total <= high):
            result.level = level.get("level", "")
            result.interpretation = level.get("interpretation", "")
            result.abnormal = bool(level.get("abnormal"))
            result.severity = level.get("severity", "none")
            result.rule_refs.append({"rule": "levels:level_map", "matched_level": result.level, "range": [low, high]})
            break
    if not result.level:
        result.needs_manual_review = True
        result.notices.append("分值未落入任何判读区间，需人工确认")

    # 阳性标记
    for flag in scoring.get("flags") or []:
        group = flag.get("config") or {}
        if evaluate_conditions(group, answers):
            result.flags.append(
                {
                    "flag": flag.get("flag", ""),
                    "severity": flag.get("severity", "medium"),
                    "symptom_codes": flag.get("symptom_codes", []),
                    "symptom_terms": [symptom_term(code) for code in flag.get("symptom_codes", [])],
                    "rule": flag.get("config", {}),
                }
            )
    if result.flags:
        result.rule_refs.append({"rule": "flags:condition", "flags": [f["flag"] for f in result.flags]})

    if missing:
        result.needs_manual_review = True
        result.notices.append(f"存在 {len(missing)} 项缺项，结论需人工确认")

    review_status = scale.get("review_status", "draft_pending_medical_review")
    if review_status != "approved":
        result.needs_manual_review = True
        result.notices.append("题库条目待医护/专家评审，结论仅供演示，不作为正式临床结论")

    result.explanation = score_rule.get("explanation", "")
    return result


def branch_recommendations(scale: dict, answers: dict[str, AnswerRecord]) -> list[dict]:
    """筛查阳性 → 进入对应专项评估；阴性跳过。"""
    results: list[dict] = []
    for branch in scale.get("branches") or []:
        if evaluate_conditions(branch.get("when") or {}, answers):
            results.append(
                {
                    "branch_code": branch.get("code", ""),
                    "target_scale": branch.get("target_scale", ""),
                    "reason": branch.get("reason", ""),
                    "source_scale": scale.get("code", ""),
                }
            )
    return results
