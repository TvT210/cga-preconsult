"""题库与疾病库的读取：JSON 为基线，数据库为运行时真相。

`docs/structured/` 下的 JSON 是评审前的基线；数据库表保存发布后的版本与评审状态，
每次评估都会记录所用的 `scale_version`，满足版本留痕要求。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from app.core.config import REPO_ROOT
from app.db.models import DiseaseProfile, ScaleTemplate

STRUCTURED_DIR = REPO_ROOT / "docs" / "structured"
SCALES_DIR = STRUCTURED_DIR / "assessment-scales"
DISEASE_DIR = STRUCTURED_DIR / "disease-library"

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


def load_symptoms() -> dict[str, dict]:
    """症状归一化字典。"""
    if "symptoms" in _cache:
        return _cache["symptoms"]
    path = DISEASE_DIR / "symptoms.json"
    table: dict[str, dict] = {}
    if path.exists():
        data = _read_json(path)
        for item in data.get("symptoms", []):
            table[item["code"]] = item
    _cache["symptoms"] = table
    return table


def symptom_term(code: str) -> str:
    entry = load_symptoms().get(code)
    return entry.get("term", code) if entry else code


def load_disease_file() -> dict:
    path = DISEASE_DIR / "diseases.json"
    if not path.exists():
        return {"diseases": []}
    try:
        return _read_json(path)
    except Exception:
        return {"diseases": []}


def list_diseases(db: Session) -> list[dict]:
    rows = {row.code: row for row in db.query(DiseaseProfile).all()}
    result: list[dict] = []
    for item in load_disease_file().get("diseases", []):
        row = rows.get(item.get("code"))
        payload = row.payload if row and row.payload else item
        result.append(
            {
                "code": item.get("code"),
                "name": item.get("name"),
                "aliases": item.get("aliases", []),
                "system": item.get("system", ""),
                "risk_level": item.get("risk_level", "observe"),
                "review_status": row.review_status if row else "draft_pending_medical_review",
                "symptom_count": len(item.get("symptoms", [])),
                "payload": payload,
            }
        )
    return result


def get_disease(db: Session, code: str) -> dict | None:
    for item in list_diseases(db):
        if item["code"] == code:
            return item
    return None
