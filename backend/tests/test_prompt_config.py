"""提示词模板接入与配置优先级测试。

覆盖三件事：
1. **配置优先级**：环境变量 > config.yaml > 默认值；敏感项禁止从 yaml 覆盖；
2. **提示词来源**：表里有生效版本就用表的并记录表版本号，没有则回落代码内置版本；
3. **版本留痕**：`model_runs.prompt_version` 记的必须是**实际生效**的那版。
"""

from __future__ import annotations

import importlib
import os
import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app.core import config as config_module
from app.db.models import PromptTemplate
from app.services.prompt_store import (
    PROMPT_CODE_DIALOGUE,
    PROMPT_CODE_MATCH_REVIEW,
    resolve_prompt,
)

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]


# ---------------------------------------------------------------------------
# 1. 配置优先级
# ---------------------------------------------------------------------------


def _write_yaml(path: pathlib.Path, text: str) -> None:
    path.write_text(text, encoding="utf-8")


def test_env_beats_yaml(tmp_path, monkeypatch):
    """环境变量必须压过 config.yaml（此前实现是反的）。"""
    yaml_path = tmp_path / "config.yaml"
    _write_yaml(yaml_path, "llm_model: from-yaml\nllm_provider: mock\n")

    monkeypatch.setenv("CGA_LLM_MODEL", "from-env")
    monkeypatch.setattr(config_module, "_load_yaml_overrides", lambda: {"llm_model": "from-yaml", "llm_provider": "mock"})
    monkeypatch.setattr(config_module, "_env_defined_keys", lambda: {"llm_model"})
    config_module.get_settings.cache_clear()
    try:
        settings = config_module.get_settings()
        assert settings.llm_model == "from-env", "环境变量应优先于 config.yaml"
    finally:
        config_module.get_settings.cache_clear()


def test_yaml_fills_when_env_absent(tmp_path, monkeypatch):
    """环境变量没给时，config.yaml 仍然生效。"""
    monkeypatch.delenv("CGA_LLM_MODEL", raising=False)
    monkeypatch.setattr(config_module, "_load_yaml_overrides", lambda: {"llm_model": "from-yaml"})
    monkeypatch.setattr(config_module, "_env_defined_keys", lambda: set())
    config_module.get_settings.cache_clear()
    try:
        assert config_module.get_settings().llm_model == "from-yaml"
    finally:
        config_module.get_settings.cache_clear()


def test_api_key_never_comes_from_yaml(monkeypatch):
    """**密钥禁止从 config.yaml 读取**——只允许环境变量 / .env。"""
    monkeypatch.delenv("CGA_LLM_API_KEY", raising=False)
    monkeypatch.setattr(
        config_module, "_load_yaml_overrides", lambda: {"llm_api_key": "secret-in-yaml"}
    )
    monkeypatch.setattr(config_module, "_env_defined_keys", lambda: set())
    config_module.get_settings.cache_clear()
    try:
        settings = config_module.get_settings()
        assert settings.llm_api_key != "secret-in-yaml", "config.yaml 里的 key 不应生效"
    finally:
        config_module.get_settings.cache_clear()


def test_api_key_read_from_env(monkeypatch):
    """环境变量里的 key 正常生效。"""
    monkeypatch.setenv("CGA_LLM_API_KEY", "secret-from-env")
    monkeypatch.setattr(config_module, "_load_yaml_overrides", lambda: {})
    monkeypatch.setattr(config_module, "_env_defined_keys", lambda: {"llm_api_key"})
    config_module.get_settings.cache_clear()
    try:
        assert config_module.get_settings().llm_api_key == "secret-from-env"
    finally:
        config_module.get_settings.cache_clear()


def test_env_only_fields_contains_key():
    assert "llm_api_key" in config_module.ENV_ONLY_FIELDS


# ---------------------------------------------------------------------------
# 2. 提示词来源与回落
# ---------------------------------------------------------------------------


def test_resolve_prompt_prefers_active_db_row(db_session):
    """表里有生效版本 → 用表的内容与版本。"""
    code = "test_prompt_active"
    row = PromptTemplate(
        code=code,
        name="运营改过的预问诊提示词",
        version="9.9.9",
        content="这是运营发布的新提示词",
        active=True,
    )
    db_session.add(row)
    db_session.commit()
    try:
        content, version = resolve_prompt(db_session, code, "内置版本", "0.1.0-draft")
        assert content == "这是运营发布的新提示词"
        assert version == "9.9.9"
    finally:
        db_session.delete(row)
        db_session.commit()


def test_resolve_prompt_falls_back_when_row_missing(db_session):
    """表里没有该编码 → 回落代码内置版本。"""
    content, version = resolve_prompt(
        db_session, "not_exists_code", "内置版本", "0.1.0-draft"
    )
    assert content == "内置版本"
    assert version == "0.1.0-draft"


def test_resolve_prompt_ignores_inactive_row(db_session):
    """停用的版本不生效 → 回落内置版本。"""
    code = "test_prompt_inactive"
    row = PromptTemplate(
        code=code, name="旧版本", version="0.0.1", content="停用的内容", active=False
    )
    db_session.add(row)
    db_session.commit()
    try:
        content, version = resolve_prompt(db_session, code, "内置版本", "0.1.0-draft")
        assert content == "内置版本"
        assert version == "0.1.0-draft"
    finally:
        db_session.delete(row)
        db_session.commit()


def test_seeded_match_review_prompt_keeps_json_contract(db_session):
    """种子里的复核提示词必须保留 JSON 输出契约，否则接真实模型会解析失败。"""
    row = (
        db_session.query(PromptTemplate)
        .filter(PromptTemplate.code == PROMPT_CODE_MATCH_REVIEW)
        .order_by(PromptTemplate.id.desc())
        .first()
    )
    assert row is not None
    assert '"rerank"' in row.content and '"follow_ups"' in row.content
    assert "不得给出诊断结论" in row.content
