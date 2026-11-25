"""Alembic 运行环境。

两处与模板不同，都是刻意的：

1. **URL 不从 `alembic.ini` 读**，而是复用 `app.core.config.settings.sqlalchemy_url`。
   否则「应用连 A 库、迁移改 B 库」这种事迟早发生一次。
   临时切库用环境变量 `CGA_DATABASE_URL`（与运行时同一套配置）。
2. **SQLite 走 batch 模式**：SQLite 不支持 `ALTER COLUMN`，不开 batch 的话
   后续任何改列迁移都会直接失败。
"""

from __future__ import annotations

import os
import sys
from logging.config import fileConfig
from pathlib import Path

from alembic import context
from sqlalchemy import engine_from_config, pool

# 保证 `python -m alembic` 在 backend/ 或仓库根目录执行都能导入 app
BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.core.config import settings  # noqa: E402
from app.db.base import Base  # noqa: E402
import app.db.models  # noqa: E402,F401  仅为把全部表注册进 Base.metadata

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata

def _database_url() -> str:
    """迁移连接串：环境变量优先（便于在临时库上验证），否则与运行时一致。

    刻意在**每次调用时**读环境变量，而不是模块加载时算一次——测试要在同进程里
    对多个临时库跑迁移，导入期定值会让它们全落到同一个库上。
    """
    return os.environ.get("CGA_DATABASE_URL") or settings.sqlalchemy_url


def _is_sqlite(url: str) -> bool:
    return url.startswith("sqlite")


def run_migrations_offline() -> None:
    url = _database_url()
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        render_as_batch=_is_sqlite(url),
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    section = config.get_section(config.config_ini_section, {})
    section["sqlalchemy.url"] = _database_url()
    connectable = engine_from_config(section, prefix="sqlalchemy.", poolclass=pool.NullPool)

    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            render_as_batch=connection.dialect.name == "sqlite",
            compare_type=True,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
