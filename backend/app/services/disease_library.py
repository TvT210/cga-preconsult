"""疾病库与症状词表访问层（**线 B 拥有**）。

## 归属说明

`docs/structured/disease-library/**` 是疾病库与症状词表，归线 B（结论与运营）。
本模块是该数据资产在服务端**唯一的读取入口**，线 A（采集与判读）通过导入消费词表，
但不修改这里的实现——这样「谁拥有数据、谁提供能力、谁只消费」在代码层面是显式的。

`services/scales_store.py` 属线 A，只负责**题库**（21 张量表）的读取；
其中的词表函数改为对本模块的转发，线 A 侧文件无需改动即可继续使用受控词表。
"""

from __future__ import annotations

import json
import pathlib
from typing import Any

from sqlalchemy.orm import Session

from app.core.config import REPO_ROOT

STRUCTURED_DIR = REPO_ROOT / "docs" / "structured"
SCALES_DIR = STRUCTURED_DIR / "assessment-scales"
DISEASE_DIR = STRUCTURED_DIR / "disease-library"

_cache: dict[str, Any] = {}


def _read_json(path: pathlib.Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


# ---------------------------------------------------------------------------
# 症状归一化词表（受控）
# ---------------------------------------------------------------------------


def load_symptoms() -> dict[str, dict]:
    """症状归一化字典（含鉴别性追问话术 probe）。"""
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


def symptom_probe(code: str) -> str:
    """该症状的鉴别性追问话术（医生初诊用来区分同症多病）。"""
    entry = load_symptoms().get(code)
    return entry.get("probe", "") if entry else ""


def symptom_index() -> list[tuple[str, str]]:
    """(标准词, 词表 code) 的可匹配索引，按词长倒序（长词优先匹配）。"""
    table = load_symptoms()
    index: list[tuple[str, str]] = []
    for code, entry in table.items():
        index.append((entry.get("term", code), code))
        for synonym in entry.get("synonyms", []) or []:
            index.append((synonym, code))
    index.sort(key=lambda item: len(item[0]), reverse=True)
    return index


# ---------------------------------------------------------------------------
# 疾病库
# ---------------------------------------------------------------------------


def load_disease_file() -> dict:
    path = DISEASE_DIR / "diseases.json"
    if not path.exists():
        return {"diseases": []}
    try:
        return _read_json(path)
    except Exception:
        return {"diseases": []}


def list_diseases(db: Session) -> list[dict]:
    rows = {row.code: row for row in db.query(_disease_model()).all()}
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


def _disease_model():
    from app.db.models import DiseaseProfile

    return DiseaseProfile


# ---------------------------------------------------------------------------
# 证据准备（匹配引擎的输入侧）
# ---------------------------------------------------------------------------


def extract_symptoms(text: str, source: str = "preconsult") -> list[dict[str, Any]]:
    """从文本抽取症状词条（受控词表归一化），并标注证据来源。

    复用线 A 对话服务里的抽取实现（那边是纯文本 → 词表的通用能力），
    本函数只负责补上来源标记，供匹配引擎区分「对话抽取 / 预问诊自述」。
    """
    from app.services.dialogue import extract_symptoms as _extract

    items = _extract(text)
    for item in items:
        item["source"] = source
    return items


def extract_preconsult_symptoms(payload: dict) -> list[dict[str, Any]]:
    """从预问诊结构化内容中抽取症状证据（主诉 + 病史 + 生活方式 + 跌倒记录）。

    预问诊的**采集与录入**属线 A（患者端）；本函数只做只读消费，
    把线 A 已采集到的内容转成匹配引擎可用的证据。
    """
    if not payload:
        return []
    texts: list[str] = []

    chief = payload.get("chief_complaint") or {}
    for key in ("text", "site", "nature", "associated"):
        value = chief.get(key)
        if isinstance(value, list):
            texts.extend(str(item) for item in value)
        elif value:
            texts.append(str(value))

    history = payload.get("history") or {}
    texts.extend(str(item) for item in history.get("conditions") or [])
    for allergy in history.get("allergies") or []:
        if isinstance(allergy, dict):
            texts.append(str(allergy.get("reaction", "")))

    lifestyle = payload.get("lifestyle") or {}
    for key in ("diet", "activity", "sleep", "other"):
        if lifestyle.get(key):
            texts.append(str(lifestyle[key]))
    for fall in lifestyle.get("falls") or []:
        if isinstance(fall, dict):
            texts.extend(str(fall.get(key, "")) for key in ("place", "cause", "injury"))

    return extract_symptoms(" ".join(texts), source="preconsult")
