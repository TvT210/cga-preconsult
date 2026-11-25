"""评估证据包导出用例。

覆盖点：
1. 鉴权：未登录 401；老人不能导出别人的会话；不存在的会话 404；
2. 结构：schema / patient / session / score / items / integrity 六块齐全；
3. 完整性：**未作答的题也占一行**——只导出已答题会让残缺评估看起来像完整评估；
4. 自洽：求和型量表「逐题合计 == 总分」，计数型量表「阳性条数 == 总分」，错配要报出来；
5. 提示：缺项、跳过、代答、过快、未完成，都要落成可读的 warnings；
6. CSV：带 BOM（Excel 中文不乱码）、表头中文、行数与明细一致、文件名走 RFC 5987；
7. 留痕：导出这个动作本身要写审计日志（谁、什么时候、导了哪个格式）。
"""

from __future__ import annotations

import csv
import io

from fastapi.testclient import TestClient

from app.db.base import SessionLocal
from app.db.models import AuditLog
from app.main import app

client = TestClient(app)

SUM_SCALE = "B.1"  # 求和型：10 题，满分合计 100
COUNT_SCALE = "B.10"  # 计数型：FRAIL，阳性条数即总分


def _token(username: str = "nurse", password: str = "nurse12345") -> str:
    response = client.post("/api/v1/auth/login", json={"username": username, "password": password})
    assert response.status_code == 200, response.text
    return response.json()["data"]["token"]


def _headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _new_patient(token: str, name: str = "证据测试患者") -> int:
    response = client.post(
        "/api/v1/patients",
        headers=_headers(token),
        json={"name": name, "gender": "女", "birth_date": "1940-03-08", "phone": "13700000099"},
    )
    assert response.status_code == 200, response.text
    return response.json()["data"]["id"]


def _new_session(token: str, patient_id: int, scale_code: str = SUM_SCALE, **extra) -> int:
    body = {"patient_id": patient_id, "scale_code": scale_code, "mode": "staff", **extra}
    response = client.post("/api/v1/assessments", headers=_headers(token), json=body)
    assert response.status_code == 200, response.text
    return response.json()["data"]["id"]


def _questions(token: str, session_id: int) -> list[dict]:
    response = client.get(f"/api/v1/assessments/{session_id}", headers=_headers(token))
    assert response.status_code == 200, response.text
    return response.json()["data"]["questions"]


def _answer(token: str, session_id: int, code: str, value: str) -> None:
    response = client.post(
        f"/api/v1/assessments/{session_id}/answers",
        headers=_headers(token),
        json={"question_code": code, "value": value},
    )
    assert response.status_code == 200, response.text


def _answer_all(token: str, session_id: int, pick: int = 0) -> None:
    """每题选第 pick 个选项（0 = 最高分档，用于构造满分卷）。"""
    for question in _questions(token, session_id):
        options = question["options"]
        _answer(token, session_id, question["code"], options[min(pick, len(options) - 1)]["value"])


def _finish(token: str, session_id: int) -> dict:
    response = client.post(f"/api/v1/assessments/{session_id}/finish", headers=_headers(token), json={})
    assert response.status_code == 200, response.text
    return response.json()["data"]


def _completed(token: str, scale_code: str = SUM_SCALE, pick: int = 0) -> tuple[int, int]:
    patient_id = _new_patient(token)
    session_id = _new_session(token, patient_id, scale_code)
    _answer_all(token, session_id, pick)
    _finish(token, session_id)
    return patient_id, session_id


def _evidence(token: str, session_id: int) -> dict:
    response = client.get(f"/api/v1/assessments/{session_id}/evidence", headers=_headers(token))
    assert response.status_code == 200, response.text
    return response.json()["data"]


# ---------------------------------------------------------------- 鉴权


def test_requires_login():
    assert client.get("/api/v1/assessments/1/evidence").status_code == 401


def test_unknown_session_returns_404():
    token = _token()
    response = client.get("/api/v1/assessments/999901/evidence", headers=_headers(token))
    assert response.status_code == 404


def test_elder_cannot_export_other_patient():
    """老人只能导自己的证据，否则等于可以随便拉别人的作答记录。"""
    staff = _token()
    _, session_id = _completed(staff)  # 新建患者，不绑定 elder 账号

    elder = _token("elder", "elder12345")
    response = client.get(f"/api/v1/assessments/{session_id}/evidence", headers=_headers(elder))
    assert response.status_code == 403


# ---------------------------------------------------------------- 结构


def test_package_shape():
    token = _token()
    _, session_id = _completed(token)
    data = _evidence(token, session_id)

    assert set(data) == {"schema", "exported_at", "exported_by", "patient", "session", "score", "items", "integrity"}
    assert data["schema"] == "cga.evidence/v1"
    assert data["session"]["scale_code"] == SUM_SCALE
    assert data["session"]["status"] in {"finished", "reviewed"}
    assert data["session"]["duration_seconds"] is not None
    assert data["patient"]["name"], "证据包必须能对上是谁的"
    assert data["patient"]["age"] and data["patient"]["age"] > 0, "年龄应由出生日期算出"


def test_items_follow_questionnaire_order():
    token = _token()
    _, session_id = _completed(token)
    data = _evidence(token, session_id)

    codes_in_scale = [question["code"] for question in _questions(token, session_id)]
    assert [item["question_code"] for item in data["items"]] == codes_in_scale
    assert [item["seq"] for item in data["items"]] == list(range(1, len(codes_in_scale) + 1))


def test_item_carries_semantics_and_score():
    """明细不能只有编码：复核的人要看得懂「B1-01 答了什么、得几分、满分多少」。"""
    token = _token()
    _, session_id = _completed(token)
    first = _evidence(token, session_id)["items"][0]

    assert first["text"], "题干缺失"
    assert first["section_title"], "所属维度缺失"
    assert first["value_label"], "作答文本缺失（只存了原始值，人看不懂）"
    assert first["max_score"] > 0
    assert first["status"] == "answered"
    assert first["answered_at"]


# ---------------------------------------------------------------- 完整性


def test_unanswered_items_are_exported():
    """一题都没答也要能导出，且每道题都占一行——缺项本身就是证据的一部分。"""
    token = _token()
    patient_id = _new_patient(token)
    session_id = _new_session(token, patient_id)

    data = _evidence(token, session_id)
    assert len(data["items"]) == len(_questions(token, session_id))
    assert all(item["status"] == "unanswered" for item in data["items"])

    integrity = data["integrity"]
    assert integrity["unanswered"] == len(data["items"])
    assert integrity["completeness"] == 0.0
    assert integrity["passed"] is False
    assert any("从未作答" in warning for warning in integrity["warnings"])
    assert any("阶段快照" in warning for warning in integrity["warnings"])
    assert data["score"] is None, "未完成会话不应有判读结果"


def test_skipped_item_keeps_reason():
    token = _token()
    patient_id = _new_patient(token)
    session_id = _new_session(token, patient_id)
    first_code = _questions(token, session_id)[0]["code"]

    skipped = client.post(
        f"/api/v1/assessments/{session_id}/skip",
        headers=_headers(token),
        json={"question_code": first_code, "reason": "老人拒绝回答"},
    )
    assert skipped.status_code == 200, skipped.text

    item = _evidence(token, session_id)["items"][0]
    assert item["status"] == "skipped"
    assert item["skip_reason"] == "老人拒绝回答"
    assert item["score"] is None

    # 有缺口就不能判「证据可用」：缺一题的总分与满分卷不可比，即便加总没错
    integrity = _evidence(token, session_id)["integrity"]
    assert integrity["skipped"] == 1
    assert integrity["passed"] is False
    assert any("被跳过" in warning for warning in integrity["warnings"])


# ---------------------------------------------------------------- 自洽校验


def test_sum_rule_matches_total():
    token = _token()
    _, session_id = _completed(token, SUM_SCALE, pick=0)
    integrity = _evidence(token, session_id)["integrity"]

    assert integrity["rule_type"] == "sum"
    assert integrity["rule_consistent"] is True
    assert integrity["expected_total"] == integrity["recorded_total"]
    assert integrity["item_score_sum"] == integrity["recorded_total"]
    assert integrity["passed"] is True


def test_count_rule_uses_positive_items():
    """计数型量表的「总分」是阳性条数，不能拿分值求和对——否则会误报不一致。"""
    token = _token()
    _, session_id = _completed(token, COUNT_SCALE, pick=0)
    data = _evidence(token, session_id)
    integrity = data["integrity"]

    assert integrity["rule_type"] == "count_positive"
    assert integrity["expected_total"] == integrity["positive_items"]
    assert integrity["rule_consistent"] is True


def test_proxy_answers_are_flagged():
    token = _token()
    patient_id = _new_patient(token)
    session_id = _new_session(token, patient_id, SUM_SCALE, proxy_name="李小明", proxy_relation="儿子")
    _answer_all(token, session_id, pick=0)
    _finish(token, session_id)

    data = _evidence(token, session_id)
    assert data["session"]["proxy_name"] == "李小明"
    assert data["integrity"]["proxy_answered"] == len(data["items"])
    assert any("家属代答" in warning for warning in data["integrity"]["warnings"])


# ---------------------------------------------------------------- CSV


def test_csv_has_bom_and_chinese_header():
    token = _token()
    _, session_id = _completed(token)

    response = client.get(f"/api/v1/assessments/{session_id}/evidence.csv", headers=_headers(token))
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/csv")
    # 没有 BOM 时 Excel 会把中文读成乱码，这条是硬性要求
    assert response.content.startswith(b"\xef\xbb\xbf")

    text = response.content.decode("utf-8-sig")
    rows = list(csv.reader(io.StringIO(text)))
    assert rows[0][:4] == ["序号", "题目编码", "所属维度", "题目"]
    assert len(rows) == len(_evidence(token, session_id)["items"]) + 1


def test_csv_filename_is_rfc5987_encoded():
    token = _token()
    _, session_id = _completed(token)

    response = client.get(f"/api/v1/assessments/{session_id}/evidence.csv", headers=_headers(token))
    disposition = response.headers["content-disposition"]
    assert disposition.startswith("attachment;")
    assert 'filename="evidence_' in disposition, "缺少 ASCII 兜底文件名"
    assert "filename*=UTF-8''" in disposition, "缺少 RFC 5987 中文文件名"
    assert response.headers["x-evidence-items"].isdigit()


def test_csv_marks_unanswered_status():
    token = _token()
    patient_id = _new_patient(token)
    session_id = _new_session(token, patient_id)

    response = client.get(f"/api/v1/assessments/{session_id}/evidence.csv", headers=_headers(token))
    rows = list(csv.reader(io.StringIO(response.content.decode("utf-8-sig"))))
    status_column = rows[0].index("作答状态")
    assert all(row[status_column] == "未作答" for row in rows[1:])


# ---------------------------------------------------------------- 留痕


def test_export_is_audited():
    """证据包会被下载到本地，导出动作本身必须留痕。"""
    token = _token()
    _, session_id = _completed(token)
    _evidence(token, session_id)
    client.get(f"/api/v1/assessments/{session_id}/evidence.csv", headers=_headers(token))

    db = SessionLocal()
    try:
        actions = (
            db.query(AuditLog)
            .filter(AuditLog.action == "export_evidence", AuditLog.target_id == str(session_id))
            .all()
        )
        formats = {entry.detail.get("format") for entry in actions if entry.detail}
        assert {"json", "csv"} <= formats
    finally:
        db.close()
