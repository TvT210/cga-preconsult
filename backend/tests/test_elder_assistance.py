"""A-9 一键呼叫人工协助 · 后端用例。

覆盖点：
1. 老人点一次落一条 `pending`，患者固定为本人（请求体里塞别人的 patient_id 不生效）；
2. 能挂到自己的会话与题目上；挂别人的会话被拒（400）；
3. 老人只能查自己的请求；
4. 医护能看到待处理列表并带患者姓名；处理后变 `handled` 并留处理人与时间；
5. 重复处理不覆盖首次处理人（响应时长不能被第二次点击洗成 0）；
6. 入参校验：note 超长、status 非法、未登录；
7. `/elder/support` 未配置电话时返回空串，不编号码。
"""

from __future__ import annotations

from fastapi.testclient import TestClient

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
        json={"name": name, "gender": "女", "birth_date": "1941-06-02", "phone": "13700000009"},
    )
    assert response.status_code == 200, response.text
    return response.json()["data"]["id"]


def _new_session(token: str, patient_id: int) -> int:
    response = client.post(
        "/api/v1/assessments",
        headers=_headers(token),
        json={"patient_id": patient_id, "scale_code": BARTHEL, "mode": "patient"},
    )
    assert response.status_code == 200, response.text
    return response.json()["data"]["id"]


def test_elder_creates_assistance_for_self():
    elder = _login("elder", "elder12345")
    headers = _headers(elder["token"])
    response = client.post(
        "/api/v1/elder/assistance",
        headers=headers,
        json={"question_code": "B1-01", "note": "这道题看不懂"},
    )
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["status"] == "pending"
    assert data["patient_id"] == elder["user"]["patient_id"]
    assert data["question_code"] == "B1-01"
    assert data["handled_by"] == ""
    assert data["handled_at"] == ""


def test_elder_cannot_request_for_other_patient():
    """请求体里指定别人的 patient_id 一律被忽略，老人只能为本人求助。"""
    elder = _login("elder", "elder12345")
    nurse = _login("nurse", "nurse12345")
    other_id = _new_patient(nurse["token"], "被冒用患者")
    response = client.post(
        "/api/v1/elder/assistance",
        headers=_headers(elder["token"]),
        json={"patient_id": other_id},
    )
    assert response.status_code == 200, response.text
    assert response.json()["data"]["patient_id"] == elder["user"]["patient_id"]


def test_assistance_can_attach_own_session():
    elder = _login("elder", "elder12345")
    headers = _headers(elder["token"])
    patient_id = elder["user"]["patient_id"]
    session_id = _new_session(elder["token"], patient_id)
    response = client.post(
        "/api/v1/elder/assistance",
        headers=headers,
        json={"session_id": session_id, "question_code": "B1-02"},
    )
    assert response.status_code == 200, response.text
    assert response.json()["data"]["session_id"] == session_id


def test_assistance_rejects_foreign_session():
    elder = _login("elder", "elder12345")
    nurse = _login("nurse", "nurse12345")
    other_id = _new_patient(nurse["token"], "会话越界患者")
    foreign_session = _new_session(nurse["token"], other_id)
    response = client.post(
        "/api/v1/elder/assistance",
        headers=_headers(elder["token"]),
        json={"session_id": foreign_session},
    )
    assert response.status_code == 400
    assert "不属于该患者" in response.json()["message"]


def test_elder_lists_only_own_requests():
    elder = _login("elder", "elder12345")
    nurse = _login("nurse", "nurse12345")
    other_id = _new_patient(nurse["token"], "他人求助患者")
    client.post(
        "/api/v1/elder/assistance",
        headers=_headers(nurse["token"]),
        json={"patient_id": other_id, "note": "医护代发起"},
    )
    rows = client.get("/api/v1/elder/assistance", headers=_headers(elder["token"])).json()["data"]
    assert rows, "老人自己的求助记录不应为空"
    assert all(row["patient_id"] == elder["user"]["patient_id"] for row in rows)


def test_staff_sees_pending_and_handles():
    elder = _login("elder", "elder12345")
    nurse = _login("nurse", "nurse12345")
    created = client.post(
        "/api/v1/elder/assistance",
        headers=_headers(elder["token"]),
        json={"note": "想请人念一下"},
    ).json()["data"]

    pending = client.get(
        "/api/v1/assistance?status=pending", headers=_headers(nurse["token"])
    ).json()["data"]
    target = next(row for row in pending if row["id"] == created["id"])
    assert target["patient_name"], "医护端需要患者姓名才能找到人"

    handled = client.post(
        f"/api/v1/assistance/{created['id']}/handle",
        headers=_headers(nurse["token"]),
        json={"comment": "已到床边协助"},
    ).json()["data"]
    assert handled["status"] == "handled"
    assert handled["handled_by"] == "王护士"
    assert handled["handled_at"]
    assert handled["handle_comment"] == "已到床边协助"

    after = client.get(
        "/api/v1/assistance?status=pending", headers=_headers(nurse["token"])
    ).json()["data"]
    assert all(row["id"] != created["id"] for row in after)


def test_handle_twice_keeps_first_handler():
    elder = _login("elder", "elder12345")
    nurse = _login("nurse", "nurse12345")
    doctor = _login("doctor", "doctor12345")
    created = client.post(
        "/api/v1/elder/assistance",
        headers=_headers(elder["token"]),
        json={"note": "重复处理用例"},
    ).json()["data"]

    first = client.post(
        f"/api/v1/assistance/{created['id']}/handle",
        headers=_headers(nurse["token"]),
        json={},
    ).json()["data"]
    second = client.post(
        f"/api/v1/assistance/{created['id']}/handle",
        headers=_headers(doctor["token"]),
        json={},
    ).json()["data"]
    assert second["handled_by"] == first["handled_by"] == "王护士"
    assert second["handled_at"] == first["handled_at"]


def test_note_too_long_rejected():
    elder = _login("elder", "elder12345")
    response = client.post(
        "/api/v1/elder/assistance",
        headers=_headers(elder["token"]),
        json={"note": "很" * 201},
    )
    assert response.status_code == 400
    assert "200" in response.json()["message"]


def test_invalid_status_rejected():
    nurse = _login("nurse", "nurse12345")
    response = client.get(
        "/api/v1/assistance?status=whatever", headers=_headers(nurse["token"])
    )
    assert response.status_code == 400


def test_requires_login():
    assert client.post("/api/v1/elder/assistance", json={}).status_code == 401
    assert client.get("/api/v1/assistance").status_code == 401


def test_support_without_phone_returns_empty_string():
    """未配置机构电话时不许编号码，前端据此提示现场求助。"""
    elder = _login("elder", "elder12345")
    data = client.get("/api/v1/elder/support", headers=_headers(elder["token"])).json()["data"]
    assert data["phone"] == ""
    assert data["hours"] == ""
    assert "工作人员" in data["note"]


def test_handle_unknown_request_404():
    nurse = _login("nurse", "nurse12345")
    response = client.post(
        "/api/v1/assistance/999999/handle", headers=_headers(nurse["token"]), json={}
    )
    assert response.status_code == 404
