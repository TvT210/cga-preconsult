"""实测项接口级验证：只提交实测秒数时，分档由服务端按题库区间裁定（线 A）。

对应计划 §8 验收标准第 4 条：提交步速 4.5 s 应落到「<4.82 s → 4 分」，而不是把 4.5 当分值。
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


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
        json={"name": name, "gender": "男", "birth_date": "1944-05-12", "phone": "13700000001"},
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


def test_sppb_accepts_measured_only_and_lands_on_band():
    token = _token()
    patient_id = _new_patient(token, "实测老人甲")
    session_id = _new_session(token, patient_id, "B.3")

    # 只提交实测值，不指定选项：4.5 s 应落到 <4.82 s 档
    first = client.post(
        f"/api/v1/assessments/{session_id}/answers",
        headers=_headers(token),
        json={"question_code": "B3-04", "measured": 4.5},
    )
    assert first.status_code == 200, first.text
    assert first.json()["data"]["answer"]["score"] == 4.0
    assert first.json()["data"]["answer"]["value"] == "lt_4_82"

    # 其余题目按分档逐题作答
    rest = {
        "B3-01": "hold",
        "B3-02": "hold",
        "B3-03": "hold",
        "B3-05": "lte_11_19",
    }
    for code, value in rest.items():
        response = client.post(
            f"/api/v1/assessments/{session_id}/answers",
            headers=_headers(token),
            json={"question_code": code, "value": value},
        )
        assert response.status_code == 200, response.text

    finished = client.post(f"/api/v1/assessments/{session_id}/finish", headers=_headers(token))
    assert finished.status_code == 200, finished.text
    score = finished.json()["data"]["scores"][0]
    assert score["total"] == 12
    assert score["level"] == "良好"
    assert score["needs_manual_review"] is True  # 题库仍待医护评审
    assert not [n for n in score.get("rule_refs", []) if n.get("rule") == "measured:band_check"]


def test_sppb_rejects_measured_value_outside_every_band():
    token = _token()
    patient_id = _new_patient(token, "实测老人乙")
    session_id = _new_session(token, patient_id, "B.3")

    response = client.post(
        f"/api/v1/assessments/{session_id}/answers",
        headers=_headers(token),
        json={"question_code": "B3-04", "measured": 9999},
    )
    assert response.status_code == 422
    assert "分档区间" in response.json()["message"]


def test_sppb_flags_mismatch_between_measured_and_band():
    token = _token()
    patient_id = _new_patient(token, "实测老人丙")
    session_id = _new_session(token, patient_id, "B.3")

    # 明确选了「>8.70 s」却填 4.5 s：不能静默采信，需人工确认
    response = client.post(
        f"/api/v1/assessments/{session_id}/answers",
        headers=_headers(token),
        json={"question_code": "B3-04", "value": "gt_8_70", "measured": 4.5},
    )
    assert response.status_code == 200, response.text

    for code, value in {"B3-01": "hold", "B3-02": "hold", "B3-03": "hold", "B3-05": "lte_11_19"}.items():
        client.post(
            f"/api/v1/assessments/{session_id}/answers",
            headers=_headers(token),
            json={"question_code": code, "value": value},
        )

    finished = client.post(f"/api/v1/assessments/{session_id}/finish", headers=_headers(token))
    score = finished.json()["data"]["scores"][0]
    assert score["needs_manual_review"] is True
    assert any(ref.get("rule") == "measured:band_check" for ref in score["rule_refs"])


def test_new_bank_scales_are_collectable_via_api():
    token = _token()
    listed = client.get("/api/v1/scales", headers=_headers(token)).json()["data"]
    by_code = {item["code"]: item for item in listed}
    for code in ["B.3", "B.9", "B.15", "B.17", "B.20", "B.21"]:
        assert by_code[code]["item_count"] > 0, f"{code} 补录后应可采集"

    patient_id = _new_patient(token, "补录量表老人")
    for code in ["B.17", "B.21"]:
        session_id = _new_session(token, patient_id, code)
        detail = client.get(f"/api/v1/assessments/{session_id}", headers=_headers(token)).json()["data"]
        assert detail["total_questions"] > 0
        assert detail["current_question"]
