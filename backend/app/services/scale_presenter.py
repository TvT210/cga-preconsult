"""量表对外表示层：把题库原始结构展开成前端可直接渲染的字段。

题库（`docs/structured/assessment-scales/*.json`）用 `measure: {unit, hint}`
描述实测项，前端按顶层 `unit` / `unit_hint` 渲染；实测分档题（SPPB 步速、
洼田饮水时间、耳语试验词语数）在题库里表达为「带 min/max 区间的单选选项」，
前端需要知道该走「填数值 → 后端定档」而不是「手点档位」。

本模块只做**表示层展开**：

- 不改题库文件，不改计分/判读语义；
- 返回深拷贝，不污染 `get_scale()` 的原始对象；
- 幂等：对已展开的题目再次调用结果不变。

内部逻辑（计分、条件求值、分档匹配）一律使用原始结构，presenter 只作用于响应体。
"""

from __future__ import annotations

import copy
from typing import Any


def _banded_options(question: dict) -> list[dict]:
    """返回带数值区间的选项（实测分档题的档位）。"""
    options = question.get("options") or []
    return [opt for opt in options if isinstance(opt, dict) and (opt.get("min") is not None or opt.get("max") is not None)]


def is_banded_input(question: dict) -> bool:
    """是否为「填数值由后端自动定档」的实测题。

    条件：单选型 + 至少一个选项带 min/max 区间。
    """
    if question.get("input_type") != "single":
        return False
    return bool(_banded_options(question))


def present_question(question: dict) -> dict:
    """展开单题：补 `unit` / `unit_hint` / `banded_input` / `fallback_options`。"""
    presented = copy.deepcopy(question)
    measure = question.get("measure") or {}
    if isinstance(measure, dict):
        # measure 原字段保留；顶层补前端约定的同义字段
        if measure.get("unit") and not presented.get("unit"):
            presented["unit"] = measure["unit"]
        if measure.get("hint") and not presented.get("unit_hint"):
            presented["unit_hint"] = measure["hint"]

    if is_banded_input(question):
        options = question.get("options") or []
        presented["banded_input"] = True
        presented["fallback_options"] = [
            str(opt.get("value"))
            for opt in options
            if isinstance(opt, dict) and opt.get("min") is None and opt.get("max") is None
        ]
    return presented


def present_sections(sections: list[dict] | None) -> list[dict]:
    """展开整组小节（含其下全部题目）。"""
    presented: list[dict] = []
    for section in sections or []:
        item = copy.deepcopy(section)
        item["questions"] = [present_question(q) for q in section.get("questions", [])]
        presented.append(item)
    return presented


def present_scale(scale: dict) -> dict:
    """展开整份量表定义（sections 内的题目全部展开）。"""
    presented = copy.deepcopy(scale)
    presented["sections"] = present_sections(scale.get("sections"))
    return presented


def present_questions(questions: list[dict]) -> list[dict]:
    """展开扁平题目列表（会话载荷用）。"""
    return [present_question(q) for q in questions or []]
