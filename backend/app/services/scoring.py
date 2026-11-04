"""自动计分与判读引擎。

两阶段设计：
1. `score` 阶段算出分值（sum / count_positive / max）；
2. `levels` 阶段把分值映射为等级与判读结论；`flags` 阶段给出阳性标记与症状映射。

每个结论都记录 `rule_refs`（题目 → 取值 → 分值 → 规则条目），可回溯到作答与规则，
满足「规则可解释」「结论可回溯到题目与规则条目」要求。
缺项或超范围时标记 `needs_manual_review`，不强行出结论。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from app.services.scales_store import symptom_term

_POSITIVE_VALUES = {"yes", "y", "true", "1", "是"}


def _tokens(answer: "AnswerRecord | None") -> list[str]:
    """多选答案以逗号串存储，比较时拆成词条集合。"""
    if answer is None or answer.skipped or not answer.value:
        return []
    return [part.strip() for part in str(answer.value).split(",") if part.strip()]


def _is_positive(answer: "AnswerRecord | None") -> bool:
    """把「是 / 1 / 有阳性分值」统一视为阳性。"""
    if answer is None or not answer.present:
        return False
    if any(token in _POSITIVE_VALUES for token in _tokens(answer)):
        return True
    return bool(answer.score and answer.score > 0)


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

    - `eq` / `ne` / `in` 比较所选选项的 value 字符串（多选按逗号拆成词条集合）；
    - `lt` / `lte` / `gt` / `gte` 比较所选选项的 score 数值。
    """
    answer = answers.get(condition.get("question", ""))
    if answer is None or answer.skipped:
        return False
    op = condition.get("op", "eq")
    value = condition.get("value")
    tokens = _tokens(answer)
    if op in {"eq", "ne", "in"}:
        if op == "eq":
            return bool(tokens) and (tokens == [value] or answer.value == value)
        if op == "ne":
            return not (tokens == [value] or answer.value == value)
        if isinstance(value, (list, tuple, set)):
            return any(token in value for token in tokens)
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
        return any(_check(item, answers) for item in group.get("any", []))
    if "all" in group:
        return all(_check(item, answers) for item in group.get("all", []))
    return False


def _check(entry: Any, answers: dict[str, AnswerRecord]) -> bool:
    """条件条目：字符串视为题目编码（阳性即成立），字典按条件或嵌套组求值。"""
    if isinstance(entry, str):
        return _is_positive(answers.get(entry))
    if isinstance(entry, dict):
        if "any" in entry or "all" in entry:
            return evaluate_conditions(entry, answers)
        return evaluate_condition(entry, answers)
    return False


_EXPR_TOKEN = re.compile(r"\(|\)|\bnot\b|\band\b|\bor\b|[A-Za-z_][A-Za-z0-9_]*")


def eval_criteria_expr(expr: str, groups: dict[str, bool]) -> bool:
    """`and` / `or` / `not` / 括号 / 组名的布尔表达式求值（不执行任意代码）。"""
    tokens = _EXPR_TOKEN.findall(expr or "")
    pos = 0

    def peek() -> str:
        return tokens[pos] if pos < len(tokens) else ""

    def parse_or() -> bool:
        nonlocal pos
        value = parse_and()
        while peek() == "or":
            pos += 1
            value = parse_and() or value
        return value

    def parse_and() -> bool:
        nonlocal pos
        value = parse_not()
        while peek() == "and":
            pos += 1
            value = parse_not() and value
        return value

    def parse_not() -> bool:
        nonlocal pos
        if peek() == "not":
            pos += 1
            return not parse_not()
        return parse_atom()

    def parse_atom() -> bool:
        nonlocal pos
        token = peek()
        if token == "(":
            pos += 1
            value = parse_or()
            if peek() == ")":
                pos += 1
            return value
        if token:
            pos += 1
            return bool(groups.get(token, False))
        return False

    return parse_or()


def _criteria_levels(config: dict, answers: dict[str, AnswerRecord]) -> tuple[dict | None, list[dict]]:
    """布尔组合判读：先算各组真假，再按规则顺序取第一条成立的结论。"""
    groups: dict[str, bool] = {}
    refs: list[dict] = []
    for name, definition in (config.get("groups") or {}).items():
        truth = evaluate_conditions(definition, answers)
        groups[name] = truth
        refs.append({"group": name, "label": definition.get("label", name), "positive": truth})
    for rule in config.get("rules") or []:
        expr = rule.get("expr", "default")
        if expr == "default" or eval_criteria_expr(expr, groups):
            return rule, refs
    return None, refs


def _option_meta(scale: dict, question_code: str, value: str) -> dict | None:
    for section in scale.get("sections", []):
        for question in section.get("questions", []):
            if question.get("code") != question_code:
                continue
            for option in question.get("options", []):
                if str(option.get("value")) == str(value):
                    return option
    return None


def _item_applies(item: dict, answers: dict[str, AnswerRecord]) -> bool:
    """条目级 `when`：条件成立才计入求和（如插管/非插管的二选一计分路径）。"""
    when = item.get("when")
    if not when:
        return True
    return evaluate_conditions(when, answers)


def _measured_mismatch(scale: dict, answers: dict[str, AnswerRecord]) -> list[str]:
    """实测值与所选分档是否落在同一区间；不一致时交由人工确认，不静默采信。"""
    notices: list[str] = []
    for section in scale.get("sections", []):
        for question in section.get("questions", []):
            code = question.get("code", "")
            answer = answers.get(code)
            if answer is None or answer.measured is None:
                continue
            option = _option_meta(scale, code, answer.value)
            if not option:
                continue
            low, high = _as_float(option.get("min")), _as_float(option.get("max"))
            if low is None and high is None:
                continue
            measured = float(answer.measured)
            if (low is not None and measured < low) or (high is not None and measured > high):
                notices.append(
                    f"{code} 实测值 {measured} 与所选分档「{option.get('label', answer.value)}」不一致，需人工确认"
                )
    return notices


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

    # 条目级 when：条件不成立的条目不参与求和，也不计为缺项（如 B.15 插管/非插管二选一）
    items = [item for item in items if _item_applies(item, answers)]
    if not items:
        result.notices.append("计分条目均未满足适用条件（如插管状态未选择），需人工确认")
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

    # 判级：level_map（区间）／criteria（布尔组合）／single_option_level（选项直挂结论）
    levels_rule = scoring.get("levels") or {}
    levels_type = levels_rule.get("rule_type", "level_map")
    levels_config = levels_rule.get("config") or {}
    levels = levels_config.get("levels") or []

    if levels_type == "criteria":
        matched, group_refs = _criteria_levels(levels_config, answers)
        result.rule_refs.append({"rule": "levels:criteria", "groups": group_refs})
        if matched is None:
            result.needs_manual_review = True
            result.notices.append("判读规则未命中任何结论分支，需人工确认")
        else:
            result.level = matched.get("level", "")
            result.interpretation = matched.get("interpretation", "")
            result.abnormal = bool(matched.get("abnormal"))
            result.severity = matched.get("severity", "none")
            result.total = float(sum(1 for ref in group_refs if ref["positive"]))
            result.rule_refs.append(
                {"rule": "levels:criteria", "expr": matched.get("expr", ""), "matched_level": result.level}
            )
    elif levels_type == "single_option_level":
        target = levels_config.get("question", "")
        answer = answers.get(target)
        option = _option_meta(scale, target, answer.value) if answer is not None and answer.present else None
        if option is None:
            result.needs_manual_review = True
            result.notices.append(f"判读所依赖的题目 {target} 未作答或取值无效，需人工确认")
        else:
            result.level = option.get("level", "")
            result.interpretation = option.get("interpretation", "")
            result.abnormal = bool(option.get("abnormal"))
            result.severity = option.get("severity", "none")
            result.rule_refs.append(
                {"rule": "levels:single_option_level", "question": target, "value": answer.value,
                 "matched_level": result.level}
            )
    else:
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

    mismatches = _measured_mismatch(scale, answers)
    if mismatches:
        result.needs_manual_review = True
        result.notices.extend(mismatches)
        result.rule_refs.append({"rule": "measured:band_check", "mismatches": mismatches})

    if scale.get("review_required"):
        result.needs_manual_review = True
        result.notices.append("本标准明确要求由医务人员判断，系统结论仅作记录，需人工确认")

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
