"""迁移与模型的一致性防线（S1）。

三个断言，分别防三件事：

1. 迁移建出来的表 == 模型定义的表 —— 防「加了模型忘了写迁移」；
2. `alembic.check` 无差异 —— 防「迁移写了一半，列/索引对不上」；
3. `downgrade base` 能清空 —— 防「回滚是假的」。

跑在临时库上，不碰 `backend/data/cga.db`。
"""

from __future__ import annotations

from pathlib import Path

import pytest
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from sqlalchemy import create_engine, inspect

import app.db.models  # noqa: F401  注册全部表
from app.db.base import Base

BACKEND_DIR = Path(__file__).resolve().parents[1]
ALEMBIC_INI = BACKEND_DIR / "alembic.ini"

pytestmark = pytest.mark.filterwarnings("ignore::DeprecationWarning")


def _config(url: str) -> tuple[Config, str]:
    """构造 alembic 配置，并把连接串经环境变量传给 env.py。"""
    cfg = Config(str(ALEMBIC_INI))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "alembic"))
    return cfg, url


@pytest.fixture()
def temp_db(tmp_path, monkeypatch):
    url = f"sqlite:///{(tmp_path / 'migration.db').as_posix()}"
    monkeypatch.setenv("CGA_DATABASE_URL", url)
    return url


def _tables(url: str) -> set[str]:
    engine = create_engine(url)
    try:
        return set(inspect(engine).get_table_names())
    finally:
        engine.dispose()


def test_upgrade_head_creates_every_model_table(temp_db):
    cfg, url = _config(temp_db)
    command.upgrade(cfg, "head")

    created = _tables(url) - {"alembic_version"}
    expected = set(Base.metadata.tables)
    assert created == expected, (
        f"迁移漏建：{sorted(expected - created)}；迁移多建：{sorted(created - expected)}"
    )


def test_migration_matches_models_without_diff(temp_db):
    """模型改了但没写迁移时，这里会红。"""
    cfg, url = _config(temp_db)
    command.upgrade(cfg, "head")

    engine = create_engine(url)
    try:
        with engine.connect() as conn:
            diff = compare_metadata(
                MigrationContext.configure(conn, opts={"compare_type": True}),
                Base.metadata,
            )
    finally:
        engine.dispose()

    assert diff == [], f"模型与迁移存在差异：{diff}"


def test_downgrade_base_drops_schema(temp_db):
    cfg, url = _config(temp_db)
    command.upgrade(cfg, "head")
    command.downgrade(cfg, "base")

    remaining = _tables(url) - {"alembic_version"}
    assert remaining == set(), f"降级后仍有残留表：{sorted(remaining)}"


def test_alembic_ini_is_ascii_only():
    """configparser 用系统 locale 读 ini，Windows 上是 GBK。

    只要有人往 ini 里写中文注释，`alembic` 就会在启动时报
    `UnicodeDecodeError: 'gbk' codec can't decode`——报错位置与原因完全不相干，
    排查成本极高。这条测试把它拦在前面。
    """
    raw = ALEMBIC_INI.read_bytes()
    offenders = [(i, b) for i, b in enumerate(raw) if b > 0x7F]
    assert not offenders, f"alembic.ini 含非 ASCII 字节，首个位于偏移 {offenders[0][0]}"
