"""实测项表示层验证（线 A / A-2）。

题库用 `measure: {unit, hint}` 描述实测项，实测分档题在题库里表达为
「带 min/max 区间的单选选项」。本文件钉住三件事：

1. 表示层把 `measure.unit/hint` 展开成前端约定的顶层字段，且不改动原始题库；
2. 实测分档题被正确标注 `banded_input` 与 `fallback_options`（「不能完成」类兜底项）；
3. 只填实测值时，逐题作答与断点续填都能拿到原始实测值。
"""

from __future__ import annotations

import json

from fastapi.testclient import TestClient

from app.main import app
from app.services.scale_presenter import (
    is_banded_input,
    present_question,
    present_scale,
    present_sections,
)
from app.services.scales_store import SCALES_DIR

client = TestClient(app)


def _load(code: str) -> dict:
    return json.loads((SCALES_DIR / f"{code}.json").read_text(encoding="utf-8"))


def _questions(scale: dict) -> dict[str, dict]:
    return {q["code"]: q for s in scale.get("sections", []) for q in s.get("questions", [])}


def _token() -> str:
    response = client.post("/api/v1/auth/login", json={"username": "nurse", "password": "nurse12345"})
    assert response.status_code == 200, response.text
    return response.json()["data"]["token"]


def _headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _new_patient(token: str, name: str) -> int:
    response = client.post(
        "/api/v1/patients",
        headers=_headers(token),
        json={"name": name, "gender": "男", "birth_date": "1944-05-12", "phone": "13700000011"},
    )
    assert response.status_code == 200, response.text
    return response.json()["data"]["id"]


def _new_session(token: str, patient_id: int, scale_code: str) -> int:
    response = client.post(
        "/api/v1/assessments",
        headers=_headers(token),
        json={"patient_id": patient_id, "scale_code": scale_code, "mode": "staff"},
    )
    assert response.status_code == 200, response.text
    return response.json()["data"]["id"]


# ---------------------------------------------------------------- 表示层纯函数


def test_measure_is_expanded_to_top_level_unit_and_hint():
    question = _questions(_load("B.3"))["B3-04"]
    assert question["measure"]["unit"] == "s"

    presented = present_question(question)
    assert presented["unit"] == "s"
    assert presented["unit_hint"] == question["measure"]["hint"]
    # 原字段保留，向后兼容
    assert presented["measure"] == question["measure"]


def test_presenter_does_not_mutate_source_scale():
    scale = _load("B.3")
    before = json.dumps(scale, ensure_ascii=False, sort_keys=True)

    present_scale(scale)

    assert json.dumps(scale, ensure_ascii=False, sort_keys=True) == before
    # 缓存对象尤其不能被污染：get_scale 回退到 JSON 基线时返回的是同一个字典
    assert "unit" not in _questions(scale)["B3-04"]


def test_presenter_is_idempotent():
    question = _questions(_load("B.17"))["B17-01"]
    once = present_question(question)
    twice = present_question(once)
    assert once == twice


def test_banded_input_detected_only_for_single_choice_with_ranges():
    b3 = _questions(_load("B.3"))
    b12 = _questions(_load("B.12"))
    b17 = _questions(_load("B.17"))
    b7 = _questions(_load("B.7"))
    b1 = _questions(_load("B.1"))

    # 实测分档题：单选 + 选项带 min/max
    for code in ("B3-01", "B3-02", "B3-03", "B3-04", "B3-05"):
        assert is_banded_input(b3[code]), f"{code} 应为实测分档题"
    assert is_banded_input(b17["B17-01"])
    assert is_banded_input(b7["B7-01"])

    # number 型记录项与普通单选题不得被误判
    assert not is_banded_input(b12["B12-01"])
    assert not is_banded_input(b1["B1-01"])


def test_fallback_options_exclude_numeric_bands():
    # B.3 步速：5 个档位中只有「不能完成」没有数值区间
    presented = present_question(_questions(_load("B.3"))["B3-04"])
    assert presented["banded_input"] is True
    assert presented["fallback_options"] == ["unable"]

    # B.17 洼田：1 级两个时间细分带区间，2~5 级靠表现定档 → 都是兜底项
    presented = present_question(_questions(_load("B.17"))["B17-01"])
    assert presented["fallback_options"] == ["l2", "l3", "l4", "l5"]


def test_questions_without_measure_get_no_extra_fields():
    presented = present_sections(_load("B.1")["sections"])
    question = presented[0]["questions"][0]
    for field in ("unit", "unit_hint", "banded_input", "fallback_options"):
        assert field not in question, f"{question['code']} 不应带 {field}"


# ---------------------------------------------------------------- 接口层


def test_scale_detail_api_returns_presented_questions():
    token = _token()
    detail = client.get("/api/v1/scales/B.3", headers=_headers(token)).json()["data"]
    table = {q["code"]: q for s in detail["sections"] for q in s["questions"]}

    speed = table["B3-04"]
    assert speed["unit"] == "s"
    assert speed["unit_hint"]
    assert speed["banded_input"] is True
    assert speed["fallback_options"] == ["unable"]
    # 分档区间必须原样保留，前端要靠它本地预演落档
    ranges = {opt["value"]: (opt.get("min"), opt.get("max")) for opt in speed["options"]}
    assert ranges["lt_4_82"] == (0, 4.82)
    assert ranges["unable"] == (None, None)


def test_scale_detail_api_keeps_plain_scales_unchanged():
    token = _token()
    detail = client.get("/api/v1/scales/B.1", headers=_headers(token)).json()["data"]
    question = detail["sections"][0]["questions"][0]
    assert "unit" not in question
    assert "banded_input" not in question
    # 既有字段仍可用
    assert question["input_type"] == "single"
    assert question["options"]


def test_session_payload_presents_questions_and_sections_consistently():
    token = _token()
    patient_id = _new_patient(token, "表示层一致老人")
    session_id = _new_session(token, patient_id, "B.3")

    payload = client.get(f"/api/v1/assessments/{session_id}", headers=_headers(token)).json()["data"]
    flat = {q["code"]: q for q in payload["questions"]}
    nested = {q["code"]: q for s in payload["sections"] for q in s["questions"]}

    assert flat.keys() == nested.keys()
    for code, question in nested.items():
        assert flat[code]["unit"] == question.get("unit"), f"{code} 两处字段不一致"


def test_measured_value_survives_session_reload():
    """断点续填：只提交实测值时，重新拉会话要能还原原始秒数。"""
    token = _token()
    patient_id = _new_patient(token, "续填实测老人")
    session_id = _new_session(token, patient_id, "B.3")

    saved = client.post(
        f"/api/v1/assessments/{session_id}/answers",
        headers=_headers(token),
        json={"question_code": "B3-04", "measured": 5.5},
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["data"]["answer"]["value"] == "4_82_6_20"

    payload = client.get(f"/api/v1/assessments/{session_id}", headers=_headers(token)).json()["data"]
    answer = next(a for a in payload["answers"] if a["question_code"] == "B3-04")
    assert answer["measured"] == 5.5
    assert answer["value"] == "4_82_6_20"
    assert answer["score"] == 3.0


def test_fallback_option_still_submittable_after_measured_input():
    """先填数值、再改选「不能完成」：以兜底选项为准，实测值仍留痕。"""
    token = _token()
    patient_id = _new_patient(token, "兜底选项老人")
    session_id = _new_session(token, patient_id, "B.3")

    client.post(
        f"/api/v1/assessments/{session_id}/answers",
        headers=_headers(token),
        json={"question_code": "B3-04", "measured": 4.5},
    )
    response = client.post(
        f"/api/v1/assessments/{session_id}/answers",
        headers=_headers(token),
        json={"question_code": "B3-04", "value": "unable"},
    )
    assert response.status_code == 200, response.text
    answer = response.json()["data"]["answer"]
    assert answer["value"] == "unable"
    assert answer["score"] == 0.0


def test_wadian_test_banded_and_fallback_paths():
    """洼田饮水试验：时间细分走实测定档，表现分级走兜底选项。"""
    token = _token()
    patient_id = _new_patient(token, "洼田老人")
    session_id = _new_session(token, patient_id, "B.17")

    # 4.5 s 一次喝完无呛咳 → 1 级（≤5 s）
    fast = client.post(
        f"/api/v1/assessments/{session_id}/answers",
        headers=_headers(token),
        json={"question_code": "B17-01", "measured": 4.5},
    )
    assert fast.status_code == 200, fast.text
    assert fast.json()["data"]["answer"]["value"] == "l1_within5"
    assert fast.json()["data"]["answer"]["score"] == 1.0

    # 改判为 3 级（一次喝完但有呛咳）→ 兜底选项直接生效
    graded = client.post(
        f"/api/v1/assessments/{session_id}/answers",
        headers=_headers(token),
        json={"question_code": "B17-01", "value": "l3"},
    )
    assert graded.status_code == 200, graded.text
    assert graded.json()["data"]["answer"]["value"] == "l3"
    assert graded.json()["data"]["answer"]["score"] == 3.0


def test_presented_fields_do_not_break_scoring():
    """表示层只加字段：展开后的量表与原量表判读结论必须一致。"""
    from app.services.scoring import AnswerRecord, evaluate_scale

    scale = _load("B.3")
    picks = {
        "B3-01": "hold",
        "B3-02": "hold",
        "B3-03": "hold",
        "B3-04": "lt_4_82",
        "B3-05": "lte_11_19",
    }
    table = _questions(scale)
    answers = {
        code: AnswerRecord(value=value, score=float(
            next(o for o in table[code]["options"] if o["value"] == value)["score"]
        ))
        for code, value in picks.items()
    }

    baseline = evaluate_scale(scale, answers)
    presented = evaluate_scale(present_scale(scale), answers)

    assert presented.total == baseline.total
    assert presented.level == baseline.level
    assert [f.flag if hasattr(f, "flag") else f for f in presented.flags] == [
        f.flag if hasattr(f, "flag") else f for f in baseline.flags
    ]
