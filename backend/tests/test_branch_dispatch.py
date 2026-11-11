"""A-3 分支跳转自动派发验证（线 A）。

覆盖点：
1. 筛查阳性 → 为目标量表派生待办任务，且带得回来源会话与分支编码；
2. 环形防护：B.1 → B.3 → B.1 这类回指不再派发；
3. 幂等：同一会话重复 finish 不重复建任务；
4. 去重：患者已有该量表进行中任务时复用；
5. 不派空量表 / 不派不存在的量表；
6. 链回溯有深度上限，脏数据不会造成死循环。
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.db.models import AssessmentSession, Patient
from app.main import app
from app.services.branch_dispatch import (
    MAX_CHAIN_DEPTH,
    chain_scale_codes,
    dispatch_branches,
)

client = TestClient(app)

# 全部条目作答，避免缺项干扰判读（B.1 共 10 题，B1-09 低分触发 B.3、B1-07 低分触发 B.11）
BARTHEL_FULL = {
    "B1-01": "10",
    "B1-02": "5",
    "B1-03": "5",
    "B1-04": "10",
    "B1-05": "10",
    "B1-06": "10",
    "B1-07": "5",  # < 10 → 触发 B.11
    "B1-08": "15",
    "B1-09": "10",  # < 15 → 触发 B.3
    "B1-10": "10",
}

# B.3 全答，B3-04 取 2 分档（lte 2 → 回指 B.1，用于验证环形防护）
SPPB_SHORT_STEP = {
    "B3-01": "hold",
    "B3-02": "hold",
    "B3-03": "hold",
    "B3-04": "6_21_8_70",
    "B3-05": "lte_11_19",
}


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
        json={"name": name, "gender": "男", "birth_date": "1944-05-12", "phone": "13700000002"},
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


def _answer_all(token: str, session_id: int, answers: dict[str, str]) -> None:
    for code, value in answers.items():
        response = client.post(
            f"/api/v1/assessments/{session_id}/answers",
            headers=_headers(token),
            json={"question_code": code, "value": value},
        )
        assert response.status_code == 200, response.text


def _finish(token: str, session_id: int) -> dict:
    response = client.post(f"/api/v1/assessments/{session_id}/finish", headers=_headers(token))
    assert response.status_code == 200, response.text
    return response.json()["data"]


def _by_branch(payload: list[dict]) -> dict[str, dict]:
    return {item["branch_code"]: item for item in payload}


def test_positive_screening_dispatches_follow_up_tasks(db_session):
    token = _token()
    patient_id = _new_patient(token, "派发老人甲")
    session_id = _new_session(token, patient_id, "B.1")
    _answer_all(token, session_id, BARTHEL_FULL)

    data = _finish(token, session_id)
    dispatched = _by_branch(data["dispatched"])

    assert set(dispatched) == {"B1-B1", "B1-B2"}
    assert dispatched["B1-B1"]["target_scale"] == "B.3"
    assert dispatched["B1-B2"]["target_scale"] == "B.11"
    for item in dispatched.values():
        assert item["status"] == "dispatched"
        assert item["session_id"], "派发后应返回可直接进入的任务 id"
        assert item["session_status"] == "in_progress"
        assert item["reason"], "派发需带出触发原因，便于患者理解为什么多做一份"

    # 派出去的是「待办空壳」，不是已完成的结论
    child = db_session.get(AssessmentSession, dispatched["B1-B1"]["session_id"])
    assert child.patient_id == patient_id
    assert child.scale_code == "B.3"
    assert child.status == "in_progress"
    assert child.dispatched_from_id == session_id
    assert child.dispatch_branch_code == "B1-B1"

    # 原有 branches 字段保持不变，保证非破坏
    assert {item["branch_code"] for item in data["branches"]} == {"B1-B1", "B1-B2"}


def test_branch_back_reference_is_not_dispatched_again(db_session):
    """B.1 派发出 B.3 后，B.3 又建议回 B.1 —— 同一链上不得再派。"""
    token = _token()
    patient_id = _new_patient(token, "派发老人乙")
    root_id = _new_session(token, patient_id, "B.1")
    _answer_all(token, root_id, BARTHEL_FULL)
    root_data = _finish(token, root_id)
    sppb_id = _by_branch(root_data["dispatched"])["B1-B1"]["session_id"]

    _answer_all(token, sppb_id, SPPB_SHORT_STEP)
    sppb_data = _finish(token, sppb_id)
    branch = _by_branch(sppb_data["dispatched"])["B3-B1"]

    assert branch["target_scale"] == "B.1"
    assert branch["status"] == "skipped"
    assert branch["skip_reason"] == "cycle"
    assert branch["session_id"] is None

    # 没有新建任何 B.1 会话：患者名下仍是原来那一个
    b1_sessions = (
        db_session.query(AssessmentSession)
        .filter(
            AssessmentSession.patient_id == patient_id,
            AssessmentSession.scale_code == "B.1",
        )
        .count()
    )
    assert b1_sessions == 1


def test_finish_is_idempotent_for_dispatch(db_session):
    token = _token()
    patient_id = _new_patient(token, "派发老人丙")
    session_id = _new_session(token, patient_id, "B.1")
    _answer_all(token, session_id, BARTHEL_FULL)

    first = _by_branch(_finish(token, session_id)["dispatched"])
    second = _by_branch(_finish(token, session_id)["dispatched"])

    assert first["B1-B1"]["session_id"] == second["B1-B1"]["session_id"]
    assert second["B1-B1"]["status"] == "reused"
    children = (
        db_session.query(AssessmentSession)
        .filter(AssessmentSession.dispatched_from_id == session_id)
        .count()
    )
    assert children == 2, "重复 finish 不应重复派生任务"


def test_existing_in_progress_session_is_reused(db_session):
    token = _token()
    patient_id = _new_patient(token, "派发老人丁")
    existing_id = _new_session(token, patient_id, "B.3")  # 患者已自行开了 SPPB

    session_id = _new_session(token, patient_id, "B.1")
    _answer_all(token, session_id, BARTHEL_FULL)
    dispatched = _by_branch(_finish(token, session_id)["dispatched"])

    assert dispatched["B1-B1"]["status"] == "reused"
    assert dispatched["B1-B1"]["session_id"] == existing_id

    b3_sessions = (
        db_session.query(AssessmentSession)
        .filter(
            AssessmentSession.patient_id == patient_id,
            AssessmentSession.scale_code == "B.3",
        )
        .count()
    )
    assert b3_sessions == 1, "已有进行中任务时不应再建一个"


def test_dispatch_reports_skip_reasons(db_session, monkeypatch):
    token = _token()
    patient_id = _new_patient(token, "派发老人戊")
    session_id = _new_session(token, patient_id, "B.1")
    session = db_session.get(AssessmentSession, session_id)

    empty_scale = {"code": "B.99", "version": "0.1.0-draft", "sections": []}

    def fake_get_scale(_db, code):
        return empty_scale if code == "B.99" else None

    monkeypatch.setattr("app.services.branch_dispatch.get_scale", fake_get_scale)

    results = dispatch_branches(
        db_session,
        None,
        session,
        [
            {"code": "X-EMPTY", "target_scale": "B.99", "reason": "条目未补录"},
            {"code": "X-MISSING", "target_scale": "B.404", "reason": "题库无此量表"},
        ],
    )
    by_code = _by_branch(results)
    assert by_code["X-EMPTY"]["skip_reason"] == "no_questions"
    assert by_code["X-MISSING"]["skip_reason"] == "scale_missing"
    assert all(item["status"] == "skipped" for item in results)


def test_chain_walk_is_bounded(db_session):
    """脏数据造成超长链时，回溯必须在 MAX_CHAIN_DEPTH 处停下。"""
    patient = db_session.query(Patient).first()
    previous_id = None
    latest = None
    for index in range(MAX_CHAIN_DEPTH + 5):
        row = AssessmentSession(
            patient_id=patient.id,
            scale_code=f"X.{index}",
            status="finished",
            dispatched_from_id=previous_id,
        )
        db_session.add(row)
        db_session.flush()
        previous_id = row.id
        latest = row

    codes = chain_scale_codes(db_session, latest)
    assert len(codes) <= MAX_CHAIN_DEPTH + 1
