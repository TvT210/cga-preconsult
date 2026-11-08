"""提示词模板读取：优先读 `prompt_templates` 表，缺失时回落代码内置版本。

为什么要这张表
==============
`prompt_templates` 表从一期就存在并种了模板，但服务层一直**硬编码**提示词，
导致两个问题：

1. 运营侧改不动提示词——提示词在代码里，发版才能改；
2. 留痕失真——`model_runs.prompt_version` 记的是代码里的常量版本，
   与表里模板版本对不上，事后无法复现某次结论用的是哪版提示词。

本模块把两者接起来：**表里有生效版本就用表的，并记录表的版本号；
没有就用代码内置版本，并记录内置版本号**。两种来源都能追溯。

模板编码（与 `init_db.py` 播种的一致）
======================================
- ``dialogue_guide``      —— 预问诊引导式对话
- ``periodic_assessment`` —— 定期自动评估（AI 补充）
- ``match_ai_review``     —— 匹配结果的 AI 语义复核
"""

from __future__ import annotations

from typing import Any

from app.db.models import PromptTemplate

# 预问诊对话
PROMPT_CODE_DIALOGUE = "dialogue_guide"
# 定期自动评估（AI 补充）
PROMPT_CODE_PERIODIC = "periodic_assessment"
# 匹配 AI 复核
PROMPT_CODE_MATCH_REVIEW = "match_ai_review"


def resolve_prompt(
    db: Any,
    code: str,
    fallback_content: str,
    fallback_version: str,
) -> tuple[str, str]:
    """取提示词内容与版本。

    :param db: 数据库会话
    :param code: 模板编码（见模块常量）
    :param fallback_content: 表里没有可用模板时使用的代码内置版本
    :param fallback_version: 回落时记录的版本号
    :return: ``(提示词内容, 版本号)``——版本号一定非空，用于 `model_runs` 留痕
    """
    try:
        row = (
            db.query(PromptTemplate)
            .filter(PromptTemplate.code == code, PromptTemplate.active.is_(True))
            .order_by(PromptTemplate.id.desc())
            .first()
        )
    except Exception:  # pragma: no cover - 表结构异常时不应阻断主流程
        row = None
    if row is not None and (row.content or "").strip():
        return row.content, row.version or fallback_version
    return fallback_content, fallback_version
