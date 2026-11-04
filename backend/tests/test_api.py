"""API 端到端冒烟测试：登录 → 患者 → 预问诊 → 量表 → 判读 → 匹配 → 报告。"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def _login(username: str, password: str) -> dict:
    response = client.post("/api/v1/auth/login", json={"username": username, "password": password})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["code"] == 0
    return body["data"]


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def test_health():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_login_and_me():
    data = _login("nurse", "nurse12345")
    assert data["user"]["role"] == "staff"
    response = client.get("/api/v1/auth/me", headers=_auth(data["token"]))
    assert response.status_code == 200
    assert response.json()["data"]["username"] == "nurse"


def test_login_rejects_bad_password():
    response = client.post("/api/v1/auth/login", json={"username": "nurse", "password": "wrong"})
    assert response.status_code == 401


def test_require_auth():
    assert client.get("/api/v1/scales").status_code == 401


def _scale_with_items(token: str) -> dict:
    response = client.get("/api/v1/scales", headers=_auth(token))
    assert response.status_code == 200
    items = response.json()["data"]
    ready = [item for item in items if item.get("item_count", 0) > 0]
    assert ready, "题库中应至少有一张量表含条目"
    return ready[0]


def test_scales_list_and_detail():
    token = _login("nurse", "nurse12345")["token"]
    scale = _scale_with_items(token)
    response = client.get(f"/api/v1/scales/{scale['code']}", headers=_auth(token))
    assert response.status_code == 200
    detail = response.json()["data"]
    assert detail["code"] == scale["code"]
    assert detail["sections"]
    assert detail["scoring"]["levels"]


def test_end_to_end_patient_assessment_matching_report():
    token = _login("nurse", "nurse12345")["token"]
    headers = _auth(token)

    scale = _scale_with_items(token)
    detail = client.get(f"/api/v1/scales/{scale['code']}", headers=headers).json()["data"]
    questions = [q for section in detail["sections"] for q in section["questions"]]

    created = client.post(
        "/api/v1/patients",
        headers=headers,
        json={"name": "测试老人", "gender": "女", "birth_date": "1946-03-01", "phone": "13700000000"},
    )
    assert created.status_code == 200, created.text
    patient_id = created.json()["data"]["id"]

    preconsult = client.put(
        f"/api/v1/patients/{patient_id}/preconsult",
        headers=headers,
        json={
            "history": {"conditions": ["高血压", "2 型糖尿病"]},
            "chief_complaint": {"text": "反复头晕，伴走路不稳"},
            "lifestyle": {"falls": [{"time": "2026-10-20"}]},
        },
    )
    assert preconsult.status_code == 200
    assert preconsult.json()["data"]["history"]["conditions"] == ["高血压", "2 型糖尿病"]

    consent = client.post(f"/api/v1/patients/{patient_id}/consent", headers=headers, json={"agreed": True})
    assert consent.status_code == 200

    session = client.post(
        "/api/v1/assessments",
        headers=headers,
        json={"patient_id": patient_id, "scale_code": scale["code"], "mode": "staff"},
    )
    assert session.status_code == 200, session.text
    session_id = session.json()["data"]["id"]

    # 断点续填：重复创建应返回同一会话
    again = client.post(
        "/api/v1/assessments",
        headers=headers,
        json={"patient_id": patient_id, "scale_code": scale["code"], "mode": "staff"},
    )
    assert again.json()["data"]["id"] == session_id

    for question in questions:
        if question.get("input_type") in {"single", "multi"}:
            value = question["options"][0]["value"]
        else:
            value = 1
        response = client.post(
            f"/api/v1/assessments/{session_id}/answers",
            headers=headers,
            json={"question_code": question["code"], "value": value, "answered_by": "测试护士"},
        )
        assert response.status_code == 200, response.text

    finished = client.post(f"/api/v1/assessments/{session_id}/finish", headers=headers)
    assert finished.status_code == 200
    payload = finished.json()["data"]
    assert payload["scores"][0]["level"]
    assert payload["scores"][0]["rule_refs"], "结论必须可回溯到题目与规则条目"

    review = client.post(
        f"/api/v1/assessments/{session_id}/review",
        headers=headers,
        json={"action": "approve", "comment": "复核通过"},
    )
    assert review.status_code == 200
    assert review.json()["data"]["status"] == "reviewed"

    match = client.post("/api/v1/matching/run", headers=headers, json={"patient_id": patient_id})
    assert match.status_code == 200, match.text
    match_data = match.json()["data"]
    assert len(match_data["candidates"]) >= 3, "至少返回 Top-3 候选"
    top = match_data["candidates"][0]
    assert "match_score" in top and "ref_probability" in top
    assert "不构成诊断" in match_data["disclaimer"]

    report = client.post("/api/v1/reports", headers=headers, json={"patient_id": patient_id})
    assert report.status_code == 200
    report_data = report.json()["data"]
    assert report_data["sections"]["basic"]["name"] == "测试老人"
    assert report_data["sections"]["scale_results"]

    docx = client.get(f"/api/v1/reports/{report_data['id']}/export?format=docx", headers=headers)
    assert docx.status_code == 200
    assert docx.content[:2] == b"PK"
    pdf = client.get(f"/api/v1/reports/{report_data['id']}/export?format=pdf", headers=headers)
    assert pdf.status_code == 200
    assert pdf.content[:4] == b"%PDF"

    lock = client.post(f"/api/v1/reports/{report_data['id']}/lock", headers=headers)
    assert lock.status_code == 200
    assert lock.json()["data"]["locked"] is True


def test_elder_cannot_access_other_patient():
    elder = _login("elder", "elder12345")
    nurse = _login("nurse", "nurse12345")
    created = client.post(
        "/api/v1/patients",
        headers=_auth(nurse["token"]),
        json={"name": "他人患者", "gender": "男", "birth_date": "1950-01-01"},
    )
    patient_id = created.json()["data"]["id"]
    response = client.get(f"/api/v1/patients/{patient_id}", headers=_auth(elder["token"]))
    assert response.status_code == 403


def test_elder_list_endpoints_do_not_error():
    """老人角色的列表接口必须可访问（回归：曾因过滤表达式优先级错误导致 500）。"""
    elder = _login("elder", "elder12345")
    headers = _auth(elder["token"])
    for path in ("/assessments", "/reports", "/alerts", "/periodic", "/followups"):
        response = client.get(f"/api/v1{path}", headers=headers)
        assert response.status_code == 200, f"{path} -> {response.status_code} {response.text}"
        assert response.json()["code"] == 0


def test_elder_only_sees_own_data():
    elder = _login("elder", "elder12345")
    nurse = _login("nurse", "nurse12345")
    created = client.post(
        "/api/v1/patients",
        headers=_auth(nurse["token"]),
        json={"name": "非本人患者", "gender": "男", "birth_date": "1950-01-01"},
    )
    other_id = created.json()["data"]["id"]
    elder_headers = _auth(elder["token"])
    own_id = elder["user"]["patient_id"]
    assessments = client.get("/api/v1/assessments", headers=elder_headers).json()["data"]
    for item in assessments["items"]:
        assert item["patient_id"] == own_id
    reports = client.get("/api/v1/reports", headers=elder_headers).json()["data"]
    for item in reports:
        assert item["patient_id"] == own_id
    assert other_id != own_id


def test_ai_review_endpoints():
    """AI 复核：只给建议，不改结论；可读可取。"""
    token = _login("nurse", "nurse12345")["token"]
    headers = _auth(token)
    patient = client.post(
        "/api/v1/patients",
        headers=headers,
        json={"name": "AI 复核测试", "gender": "男", "birth_date": "1943-03-03"},
    ).json()["data"]
    client.put(
        f"/api/v1/patients/{patient['id']}/preconsult",
        headers=headers,
        json={"chief_complaint": {"text": "胸口压得慌、喘不上气、晕倒了一次"}},
    )
    run = client.post("/api/v1/matching/run", headers=headers, json={"patient_id": patient["id"]}).json()["data"]

    review = client.post(f"/api/v1/matching/runs/{run['id']}/ai-review", headers=headers)
    assert review.status_code == 200, review.text
    data = review.json()["data"]
    assert "rerank" in data and "follow_ups" in data and "explanations" in data
    assert "不构成诊断" in data["notice"]
    # AI 不得改写结论字段
    assert "level" not in data
    for item in data["rerank"]:
        assert "match_score" not in item and "risk_level" not in item

    fetched = client.get(f"/api/v1/matching/runs/{run['id']}/ai-review", headers=headers)
    assert fetched.status_code == 200
    assert fetched.json()["data"]["model"]


def test_ai_review_with_run_flag():
    token = _login("nurse", "nurse12345")["token"]
    headers = _auth(token)
    patient = client.post(
        "/api/v1/patients",
        headers=headers,
        json={"name": "AI 随行复核", "gender": "女", "birth_date": "1950-01-01"},
    ).json()["data"]
    run = client.post(
        "/api/v1/matching/run",
        headers=headers,
        json={"patient_id": patient["id"], "with_ai_review": True},
    ).json()["data"]
    assert "ai_review" in run, "with_ai_review=true 时应返回 AI 复核结果"


def test_report_templates_and_export():
    """报告模板：清单可查，指定模板可生成，Word/PDF 可导出。"""
    token = _login("doctor", "doctor12345")["token"]
    headers = _auth(token)
    templates = client.get("/api/v1/report-templates", headers=headers)
    assert templates.status_code == 200
    codes = {item["code"] for item in templates.json()["data"]}
    assert "professional" in codes and "plain" in codes

    patients = client.get("/api/v1/patients", headers=headers).json()["data"]["items"]
    patient_id = patients[0]["id"]
    report = client.post(
        "/api/v1/reports",
        headers=headers,
        json={"patient_id": patient_id, "template_code": "plain"},
    ).json()["data"]
    assert report["template_code"] == "plain"

    docx = client.get(f"/api/v1/reports/{report['id']}/export?format=docx", headers=headers)
    assert docx.status_code == 200 and docx.content[:2] == b"PK"
    pdf = client.get(f"/api/v1/reports/{report['id']}/export?format=pdf", headers=headers)
    assert pdf.status_code == 200 and pdf.content[:4] == b"%PDF"
    assert len(pdf.content) > 2000, "PDF 应包含封面与目录"


def test_quality_metrics_endpoint():
    token = _login("admin", "admin12345")["token"]
    metrics = client.get("/api/v1/admin/quality-metrics", headers=_auth(token)).json()["data"]
    for key in (
        "assessment_completion_rate",
        "review_rate",
        "alert_response_rate",
        "false_alert_rate",
        "scoring_consistency",
        "ai_review_coverage",
        "disease_library_coverage",
        "scale_stats",
        "stats",
    ):
        assert key in metrics, f"缺少质控指标 {key}"
    assert metrics["match_accuracy"] is None


def test_alert_can_be_marked_as_false_positive():
    token = _login("nurse", "nurse12345")["token"]
    headers = _auth(token)
    patient = client.post(
        "/api/v1/patients",
        headers=headers,
        json={"name": "误报标记测试", "gender": "女", "birth_date": "1950-01-01"},
    ).json()["data"]
    client.put(
        f"/api/v1/patients/{patient['id']}/preconsult",
        headers=headers,
        json={"chief_complaint": {"text": "头晕、没力气"}},
    )
    run = client.post("/api/v1/matching/run", headers=headers, json={"patient_id": patient["id"]}).json()["data"]
    alerts = client.get(f"/api/v1/alerts?patient_id={patient['id']}", headers=headers).json()["data"]
    if alerts:
        handled = client.post(
            f"/api/v1/alerts/{alerts[0]['id']}/handle",
            headers=headers,
            json={"action": "mark_false", "comment": "临床判断为误报"},
        )
        assert handled.status_code == 200
        assert handled.json()["data"]["is_false_positive"] is True


def test_elder_can_access_own_patient():
    elder = _login("elder", "elder12345")
    patient_id = elder["user"]["patient_id"]
    assert patient_id
    response = client.get(f"/api/v1/patients/{patient_id}", headers=_auth(elder["token"]))
    assert response.status_code == 200


def test_preconsult_symptoms_feed_matching():
    """预问诊自述必须参与疾病匹配（回归：曾只采信量表标记与对话抽取）。"""
    token = _login("nurse", "nurse12345")["token"]
    headers = _auth(token)
    patient = client.post(
        "/api/v1/patients",
        headers=headers,
        json={"name": "预问诊证据测试", "gender": "男", "birth_date": "1942-02-02"},
    ).json()["data"]
    client.put(
        f"/api/v1/patients/{patient['id']}/preconsult",
        headers=headers,
        json={
            "chief_complaint": {"text": "胸口压得慌、喘不上气、晕倒了一次"},
            "history": {"conditions": ["高血压"]},
        },
    )
    match = client.post("/api/v1/matching/run", headers=headers, json={"patient_id": patient["id"]}).json()["data"]
    codes = {item["disease_code"] for item in match["candidates"]}
    assert "I21" in codes, f"预问诊自述的胸痛与气促应召回急性心肌梗死，实际候选 {codes}"
    top = match["candidates"][0]
    assert top["hit_symptoms"], "应记录命中的症状证据"
    assert any(item.get("code") == "chest_pain" for item in top["hit_symptoms"])
    assert "不构成诊断" in match["disclaimer"]


def test_admin_metrics_and_audit():
    token = _login("admin", "admin12345")["token"]
    metrics = client.get("/api/v1/admin/quality-metrics", headers=_auth(token))
    assert metrics.status_code == 200
    assert "stats" in metrics.json()["data"]
    logs = client.get("/api/v1/admin/audit-logs", headers=_auth(token))
    assert logs.status_code == 200
    assert isinstance(logs.json()["data"], list)


def test_disease_library_and_thresholds():
    token = _login("doctor", "doctor12345")["token"]
    diseases = client.get("/api/v1/diseases", headers=_auth(token))
    assert diseases.status_code == 200
    data = diseases.json()["data"]
    assert data["diseases"], "疾病库应有条目"
    assert data["thresholds"], "阈值应入库且可配置"
    assert "不构成诊断" in data["disclaimer"]


def test_dialogue_turn_records_profile():
    token = _login("elder", "elder12345")["token"]
    patient_id = _login("elder", "elder12345")["user"]["patient_id"]
    session = client.post("/api/v1/dialogue/sessions", headers=_auth(token), json={"patient_id": patient_id})
    assert session.status_code == 200
    session_id = session.json()["data"]["id"]
    message = client.post(
        f"/api/v1/dialogue/sessions/{session_id}/messages",
        headers=_auth(token),
        json={"content": "我这几天头晕，走路也晃，还总想吐"},
    )
    assert message.status_code == 200
    payload = message.json()["data"]
    assert payload["reply"]
    assert "不构成诊断" in payload["disclaimer"]
    profile = client.get(f"/api/v1/dialogue/sessions/{session_id}/profile", headers=_auth(token))
    assert profile.status_code == 200
    assert isinstance(profile.json()["data"]["symptoms"], list)
