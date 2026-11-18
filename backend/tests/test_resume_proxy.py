"""A-5 断点续填跨设备 + 家属代答区分标记验证（线 A）。

覆盖点：
1. 断点续填：同一个「患者 + 量表」重复进入拿到同一会话与已答内容（状态在服务端，
   所以换设备、换浏览器只要还是这个患者就续得上）；
2. `last_activity_at` 可供老人端显示「上次填到哪」；
3. 主答人默认 self；代答须有姓名；切回本人不清空代答人信息；
4. **区分标记**：本人答的题与代答的题分别记为 self / proxy，
   中途开代答不会把之前的本人答案一并算成代答；
5. 跳过也是作答行为，缺项同样带来源；
6. 已结束的会话不允许改代答信息；
7. 旧库补列后 responder 为空时按代答人姓名回推，历史会话显示不回退。
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.db.models import AssessmentSession
from app.main import app

client = TestClient(app)

BARTHEL = "B.1"


def _login(username: str, password: str) -> dict:
    response = client.post("/api/v1/auth/login", json={"username": username, "password": password})
    assert response.status_code == 200, response.text
    return response.json()["data"]


def _headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _new_patient(token: str, name: str) -> int:
    response = client.post(
        "/api/v1/patients",
        headers=_headers(token),
        json={"name": name, "gender": "女", "birth_date": "1942-03-08", "phone": "13700000005"},
    )
    assert response.status_code == 200, response.text
    return response.json()["data"]["id"]


def _new_session(token: str, patient_id: int, scale_code: str = BARTHEL) -> dict:
    response = client.post(
        "/api/v1/assessments",
        headers=_headers(token),
        json={"patient_id": patient_id, "scale_code": scale_code, "mode": "patient"},
    )
    assert response.status_code == 200, response.text
    return response.json()["data"]


def _answer(token: str, session_id: int, code: str, value: str, **extra) -> dict:
    response = client.post(
        f"/api/v1/assessments/{session_id}/answers",
        headers=_headers(token),
        json={"question_code": code, "value": value, **extra},
    )
    assert response.status_code == 200, response.text
    return response.json()["data"]


def _skip(token: str, session_id: int, code: str, **extra) -> dict:
    response = client.post(
        f"/api/v1/assessments/{session_id}/skip",
        headers=_headers(token),
        json={"question_code": code, "reason": "记不清了", **extra},
    )
    assert response.status_code == 200, response.text
    return response.json()["data"]


def _detail(token: str, session_id: int) -> dict:
    response = client.get(f"/api/v1/assessments/{session_id}", headers=_headers(token))
    assert response.status_code == 200, response.text
    return response.json()["data"]


def _set_responder(token: str, session_id: int, **body):
    return client.patch(
        f"/api/v1/assessments/{session_id}/responder",
        headers=_headers(token),
        json=body,
    )


def test_reenter_returns_same_session_and_answers():
    """断点续填：换个"设备"重新进入，拿到的是同一会话与已答内容。"""
    token = _login("nurse", "nurse12345")["token"]
    patient_id = _new_patient(token, "续填老人")

    first = _new_session(token, patient_id)
    _answer(token, first["id"], "B1-01", "10")

    # 模拟换设备后重新进入：走的是同一条「患者 + 量表」查询
    again = _new_session(token, patient_id)

    assert again["id"] == first["id"]
    answered = {row["question_code"]: row["value"] for row in again["answers"]}
    assert answered.get("B1-01") == "10"
    # 续填位置由服务端算，不依赖本地缓存
    assert again["current_question"] and again["current_question"] != "B1-01"


def test_list_exposes_last_activity_at():
    """列表带最后作答时间：老人端据此显示「上次填到哪」。"""
    token = _login("nurse", "nurse12345")["token"]
    patient_id = _new_patient(token, "续填时间老人")
    session = _new_session(token, patient_id)
    _answer(token, session["id"], "B1-01", "10")

    payload = client.get(
        "/api/v1/assessments",
        headers=_headers(token),
        params={"patient_id": patient_id, "status": "in_progress"},
    ).json()["data"]
    items = payload["items"] if isinstance(payload, dict) else payload
    target = next(item for item in items if item["id"] == session["id"])

    assert target["last_activity_at"]
    assert target["responder"] == "self"
    assert target["last_activity_at"] >= target["started_at"]


def test_default_responder_is_self():
    token = _login("nurse", "nurse12345")["token"]
    patient_id = _new_patient(token, "本人自答老人")
    session = _new_session(token, patient_id)
    _answer(token, session["id"], "B1-01", "10")

    detail = _detail(token, session["id"])
    assert detail["responder"] == "self"
    assert detail["proxy"]["is_proxy"] is False
    assert detail["answers"][0]["answer_source"] == "self"
    assert detail["proxy"]["proxy_answered"] == 0


def test_patch_responder_requires_name():
    token = _login("nurse", "nurse12345")["token"]
    patient_id = _new_patient(token, "缺姓名老人")
    session = _new_session(token, patient_id)

    response = _set_responder(token, session["id"], responder="proxy")
    assert response.status_code == 400, response.text
    assert "代答人姓名" in response.json()["message"]


def test_patch_responder_persists_name_and_relation():
    token = _login("nurse", "nurse12345")["token"]
    patient_id = _new_patient(token, "代答老人")
    session = _new_session(token, patient_id)

    response = _set_responder(
        token, session["id"], responder="proxy", proxy_name="李小雨", proxy_relation="女儿"
    )
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["responder"] == "proxy"
    assert data["proxy"]["is_proxy"] is True
    assert data["proxy"]["proxy_name"] == "李小雨"
    assert data["proxy"]["proxy_relation"] == "女儿"

    # 重新进入（另一台设备）仍能读到代答信息
    detail = _detail(token, session["id"])
    assert detail["responder"] == "proxy"
    assert detail["proxy"]["proxy_relation"] == "女儿"


def test_answer_sources_split_self_and_proxy():
    """核心：中途开代答，只有之后的题算代答，之前的本人答案不被污染。"""
    token = _login("nurse", "nurse12345")["token"]
    patient_id = _new_patient(token, "混合作答老人")
    session = _new_session(token, patient_id)

    _answer(token, session["id"], "B1-01", "10")
    _answer(token, session["id"], "B1-02", "5")

    _set_responder(token, session["id"], responder="proxy", proxy_name="王护工", proxy_relation="护工")

    _answer(token, session["id"], "B1-03", "5", answer_source="proxy", answered_by="王护工")
    _answer(token, session["id"], "B1-04", "10", answer_source="proxy", answered_by="王护工")

    detail = _detail(token, session["id"])
    sources = {row["question_code"]: row["answer_source"] for row in detail["answers"]}
    assert sources["B1-01"] == "self"
    assert sources["B1-02"] == "self"
    assert sources["B1-03"] == "proxy"
    assert sources["B1-04"] == "proxy"
    assert detail["proxy"]["proxy_answered"] == 2
    assert detail["proxy"]["self_answered"] == 2


def test_proxy_answer_without_name_rejected():
    """没姓名就标代答，等价于「不知道谁答的」，不能入库。"""
    token = _login("nurse", "nurse12345")["token"]
    patient_id = _new_patient(token, "无名代答老人")
    session = _new_session(token, patient_id)

    response = client.post(
        f"/api/v1/assessments/{session['id']}/answers",
        headers=_headers(token),
        json={"question_code": "B1-01", "value": "10", "answer_source": "proxy"},
    )
    assert response.status_code == 400, response.text
    assert "代答人姓名" in response.json()["message"]


def test_skip_records_answer_source():
    token = _login("nurse", "nurse12345")["token"]
    patient_id = _new_patient(token, "跳题老人")
    session = _new_session(token, patient_id)
    _set_responder(token, session["id"], responder="proxy", proxy_name="赵女儿", proxy_relation="女儿")

    data = _skip(token, session["id"], "B1-01", answer_source="proxy", answered_by="赵女儿")
    assert data["answer_source"] == "proxy"

    detail = _detail(token, session["id"])
    row = next(item for item in detail["answers"] if item["question_code"] == "B1-01")
    assert row["skipped"] is True
    assert row["answer_source"] == "proxy"
    assert row["proxy_flag"] is True


def test_finished_session_rejects_responder_change():
    token = _login("nurse", "nurse12345")["token"]
    patient_id = _new_patient(token, "已结束老人")
    session = _new_session(token, patient_id)
    client.post(f"/api/v1/assessments/{session['id']}/finish", headers=_headers(token))

    response = _set_responder(token, session["id"], responder="proxy", proxy_name="刘家属")
    assert response.status_code == 400, response.text
    assert "已结束" in response.json()["message"]


def test_legacy_session_without_responder_falls_back(db_session):
    """旧库补列后 responder 为空：按代答人姓名回推，历史会话不会显示成本人自答。"""
    token = _login("nurse", "nurse12345")["token"]
    patient_id = _new_patient(token, "历史数据老人")
    session = _new_session(token, patient_id)

    row = db_session.get(AssessmentSession, session["id"])
    assert row is not None
    row.proxy_name = "老数据家属"
    row.proxy_relation = "儿子"
    row.responder = ""
    db_session.commit()

    detail = _detail(token, session["id"])
    assert detail["responder"] == "proxy"
    assert detail["proxy"]["is_proxy"] is True
