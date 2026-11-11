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


# --------------------------------------------------------------------- #
# A-3 遗留项：staff 端派发入口、派发溯源展示、复核改分后重新派发
# --------------------------------------------------------------------- #


def _dispatch(token: str, **payload) -> dict:
    response = client.post(
        "/api/v1/assessments/dispatch", headers=_headers(token), json=payload
    )
    assert response.status_code == 200, response.text
    return response.json()["data"]


def test_staff_can_manually_dispatch_a_scale(db_session):
    """医护手动派发：建的是同一种待办空壳，理由与派发人可追溯。"""
    token = _token()
    patient_id = _new_patient(token, "派发老人己")

    data = _dispatch(
        token, patient_id=patient_id, scale_code="B.4", reason="家属反映近期视物模糊"
    )

    assert data["status"] == "dispatched"
    assert data["target_scale"] == "B.4"
    assert data["target_name"], "派发回执要带量表名，前端才能直接展示"
    child = db_session.get(AssessmentSession, data["session_id"])
    assert child.patient_id == patient_id
    assert child.status == "in_progress"
    assert child.dispatch_reason == "家属反映近期视物模糊"
    assert child.dispatched_from_id is None, "无来源评估的人工派发不应伪造溯源"


def test_manual_dispatch_reuses_ongoing_task(db_session):
    """重复点派发不应给患者堆一串同样的空壳。"""
    token = _token()
    patient_id = _new_patient(token, "派发老人庚")

    first = _dispatch(token, patient_id=patient_id, scale_code="B.6")
    second = _dispatch(token, patient_id=patient_id, scale_code="B.6")

    assert first["status"] == "dispatched"
    assert second["status"] == "reused"
    assert second["session_id"] == first["session_id"]
    same_scale = (
        db_session.query(AssessmentSession)
        .filter(
            AssessmentSession.patient_id == patient_id,
            AssessmentSession.scale_code == "B.6",
        )
        .count()
    )
    assert same_scale == 1


def test_manual_dispatch_bypasses_cycle_guard(db_session):
    """环防护只约束机器自派生。医护要求补测链上已有的量表是合法决策。"""
    token = _token()
    patient_id = _new_patient(token, "派发老人辛")
    root_id = _new_session(token, patient_id, "B.1")
    _answer_all(token, root_id, BARTHEL_FULL)
    sppb_id = _by_branch(_finish(token, root_id)["dispatched"])["B1-B1"]["session_id"]

    data = _dispatch(
        token,
        patient_id=patient_id,
        scale_code="B.1",
        reason="复测 ADL，上次为家属代答",
        source_session_id=sppb_id,
    )

    assert data["status"] == "dispatched", "人工派发不应被环防护拦下"
    child = db_session.get(AssessmentSession, data["session_id"])
    assert child.dispatched_from_id == sppb_id
    assert child.dispatch_reason == "复测 ADL，上次为家属代答"


def test_session_payload_exposes_dispatch_trace(db_session):
    """老人端与医护端共用同一份派发溯源，不用各算一遍。"""
    token = _token()
    patient_id = _new_patient(token, "派发老人壬")
    root_id = _new_session(token, patient_id, "B.1")
    _answer_all(token, root_id, BARTHEL_FULL)
    child_id = _by_branch(_finish(token, root_id)["dispatched"])["B1-B1"]["session_id"]

    parent = client.get(f"/api/v1/assessments/{root_id}", headers=_headers(token)).json()["data"]
    assert {item["target_scale"] for item in parent["dispatched"]} == {"B.3", "B.11"}
    trace = {item["target_scale"]: item for item in parent["dispatched"]}["B.3"]
    assert trace["reason"], "派发原因要落库，否则医护看不出为什么多这一份"
    assert trace["status"] == "in_progress"
    assert trace["target_name"]

    child = client.get(f"/api/v1/assessments/{child_id}", headers=_headers(token)).json()["data"]
    assert child["dispatched_from"]["session_id"] == root_id
    assert child["dispatched_from"]["branch_code"] == "B1-B1"
    assert child["dispatched"] == [], "新建的待办任务还没有自己的后续任务"


def test_review_correction_triggers_dispatch(db_session):
    """改分让分支翻转成阳性时，复核必须补派任务，否则阳性结论落不到待办上。"""
    token = _token()
    patient_id = _new_patient(token, "派发老人癸")
    session_id = _new_session(token, patient_id, "B.1")

    # 先答成不触发任何分支：B1-09 满分 15、B1-07 满分 10
    negative = dict(BARTHEL_FULL)
    negative["B1-09"] = "15"
    negative["B1-07"] = "10"
    _answer_all(token, session_id, negative)
    assert _finish(token, session_id)["dispatched"] == []

    response = client.post(
        f"/api/v1/assessments/{session_id}/review",
        headers=_headers(token),
        json={
            "action": "correct",
            "corrections": [{"question_code": "B1-09", "value": "10"}],
            "comment": "当面复核，上下楼梯确需部分帮助",
        },
    )
    assert response.status_code == 200, response.text
    dispatched = _by_branch(response.json()["data"]["dispatched"])

    assert dispatched["B1-B1"]["status"] == "dispatched"
    assert dispatched["B1-B1"]["target_scale"] == "B.3"
    child = db_session.get(AssessmentSession, dispatched["B1-B1"]["session_id"])
    assert child.dispatched_from_id == session_id


def test_next_question_skips_inapplicable_gate(db_session):
    """不适用的题目不再作为「下一题」返回，患者不会被带到无关问题上。"""
    token = _token()
    patient_id = _new_patient(token, "派发老人子")
    session_id = _new_session(token, patient_id, "B.15")

    def next_code() -> str:
        payload = client.get(
            f"/api/v1/assessments/{session_id}", headers=_headers(token)
        ).json()["data"]
        return payload["current_question"]

    assert next_code() == "B15-00"
    _answer_all(token, session_id, {"B15-00": "non_vent"})
    assert next_code() == "B15-01"

    _answer_all(token, session_id, {"B15-01": "1", "B15-02": "1"})
    # 未插管 → B15-03（机械通气顺应性）不适用，应直接跳到 B15-04（发声）
    assert next_code() == "B15-04"
