"""题库读取：JSON 为基线，数据库为运行时真相。

**归属：线 A（采集与判读）**——本模块只负责 21 张量表题库的读取。
疾病库与症状词表属线 B，已迁至 `app/services/disease_library.py`；
下面几行仅为兼容转发，线 A 侧无需改动即可继续使用受控词表。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from app.core.config import REPO_ROOT
from app.db.models import ScaleTemplate

STRUCTURED_DIR = REPO_ROOT / "docs" / "structured"
SCALES_DIR = STRUCTURED_DIR / "assessment-scales"

_cache: dict[str, Any] = {}


def _read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def list_scale_files() -> list[Path]:
    if not SCALES_DIR.exists():
        return []
    return sorted(
        p for p in SCALES_DIR.glob("B.*.json") if p.is_file() and not p.name.startswith("_")
    )


def load_scale_files() -> dict[str, dict]:
    """从 JSON 读取全部量表题库（code → 量表定义）。"""
    if "scales" in _cache:
        return _cache["scales"]
    scales: dict[str, dict] = {}
    for path in list_scale_files():
        try:
            payload = _read_json(path)
        except Exception:
            continue
        code = payload.get("code") or path.stem
        payload.setdefault("code", code)
        scales[code] = payload
    _cache["scales"] = scales
    return scales


def get_scale(db: Session, code: str) -> dict | None:
    """取量表定义：优先数据库（可评审版本），回退到 JSON 基线。"""
    row = db.query(ScaleTemplate).filter(ScaleTemplate.code == code).first()
    if row is not None and row.payload:
        payload = dict(row.payload)
        payload.setdefault("code", row.code)
        payload.setdefault("name", row.name)
        payload.setdefault("dimension", row.dimension)
        payload.setdefault("review_status", row.review_status)
        payload.setdefault("version", row.version)
        return payload
    return load_scale_files().get(code)


def list_scales(db: Session) -> list[dict]:
    """量表清单（数据库版本优先）。"""
    rows = {row.code: row for row in db.query(ScaleTemplate).all()}
    result: list[dict] = []
    for code, payload in load_scale_files().items():
        row = rows.get(code)
        result.append(
            {
                "code": code,
                "name": payload.get("name", ""),
                "dimension": payload.get("dimension", ""),
                "method": payload.get("method", ""),
                "review_status": (row.review_status if row else payload.get("review_status", "draft_pending_medical_review")),
                "version": (row.version if row else payload.get("version", "0.1.0-draft")),
                "item_count": _count_items(payload),
                "notes": payload.get("notes", ""),
            }
        )
    for code, row in rows.items():
        if code not in {item["code"] for item in result}:
            payload = row.payload or {}
            result.append(
                {
                    "code": code,
                    "name": row.name,
                    "dimension": row.dimension,
                    "method": row.method,
                    "review_status": row.review_status,
                    "version": row.version,
                    "item_count": _count_items(payload),
                    "notes": payload.get("notes", ""),
                }
            )
    return sorted(result, key=lambda item: item["code"])


def _count_items(payload: dict) -> int:
    return sum(len(section.get("questions", [])) for section in payload.get("sections", []))


# ---------------------------------------------------------------------------
# 兼容转发：疾病库与症状词表归线 B，实现在 app/services/disease_library.py
# ---------------------------------------------------------------------------

from app.services.disease_library import (  # noqa: E402  （放在文件末尾避免循环导入）
    get_disease,
    list_diseases,
    load_disease_file,
    load_symptoms,
    symptom_probe,
    symptom_term,
)

__all__ = [
    "list_scale_files",
    "load_scale_files",
    "get_scale",
    "list_scales",
    "load_symptoms",
    "symptom_term",
    "symptom_probe",
    "load_disease_file",
    "list_diseases",
    "get_disease",
]
