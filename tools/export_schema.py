"""从 SQLAlchemy 模型导出 PostgreSQL DDL 到 docs/sql/schema.sql。"""

from __future__ import annotations

import pathlib
import sys

sys.path.insert(0, r"D:\ALLCODE\work\word2\backend")

from sqlalchemy.dialects import postgresql
from sqlalchemy.schema import CreateTable, CreateIndex

from app.db.base import Base
from app.db import models  # noqa: F401  确保所有模型被注册

OUT = pathlib.Path(r"D:\ALLCODE\work\word2\docs\sql\schema.sql")

lines = [
    "-- 老年人就医预问诊与老年综合评估系统 · PostgreSQL 表结构",
    "-- 由 backend/app/db/models.py 自动导出（勿手工修改，模型变更后重新生成）",
    "-- 生成命令：python tools/export_schema.py",
    "",
    "BEGIN;",
    "",
]

# users.patient_id 与 patients.created_by 互相引用，sorted_tables 无法排序，
# 这里直接遍历 metadata.tables，保证外键约束不被丢弃。
for table in Base.metadata.tables.values():
    ddl = str(CreateTable(table).compile(dialect=postgresql.dialect()))
    lines.append(ddl.strip() + ";")
    lines.append("")

for table in Base.metadata.tables.values():
    for index in table.indexes:
        lines.append(str(CreateIndex(index).compile(dialect=postgresql.dialect())).strip() + ";")
if any(table.indexes for table in Base.metadata.tables.values()):
    lines.append("")

lines.append("COMMIT;")
lines.append("")

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text("\n".join(lines), encoding="utf-8")
print(f"written: {OUT} ({OUT.stat().st_size} bytes, {len(Base.metadata.tables)} tables)")
