"""pytest 全局配置：测试使用独立 SQLite 数据库。"""

from __future__ import annotations

import os
import pathlib
import tempfile

import pytest

TEST_DB = pathlib.Path(tempfile.gettempdir()) / "cga_pytest.db"
if TEST_DB.exists():
    TEST_DB.unlink()
os.environ["CGA_DATABASE_URL"] = f"sqlite:///{TEST_DB.as_posix()}"
os.environ.setdefault("CGA_LLM_PROVIDER", "mock")

# 测试不依赖应用生命周期事件，直接建表并播种，保证用例可独立运行
from app.db.init_db import init_db  # noqa: E402

init_db(seed=True)


@pytest.fixture()
def db_session():
    """独立数据库会话：用例内自行提交/回滚，退出时关闭。"""
    from app.db.base import SessionLocal

    session = SessionLocal()
    try:
        yield session
    finally:
        session.rollback()
        session.close()
