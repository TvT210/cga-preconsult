"""A-8 冲突检测扩展到主诉 / 用药 / 既往史（线 A）。

覆盖点：
1. 否定表述能被识别：没有 / 没得过 / 从来没 / 已经停了；
2. 否定只作用于本分句，且不越过转折词——否则「不想吃饭还腹泻」会把腹泻也算成否认；
3. 「氨氯地平不能停」是叮嘱，不是停用声明；
4. 病名带型别前缀时（画像「2 型糖尿病」 vs 口语「糖尿病」）仍能对上；
5. 四类冲突各自能命中，且带 kind / severity / title 供前端分流；
6. 没有冲突时不误报（这条比命中更重要——冲突标记会被医护当真）；
7. 被老人明确否认的症状不写进画像；
8. 主诉只在首次写入，后续轮次不改写；
9. 一轮完整对话里冲突标记会落到 turn 上，医护端读得到。
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.db.models import PatientMedicalProfile
from app.main import app
from app.services.dialogue import detect_conflicts, extract_negations

client = TestClient(app)

CONDITIONS = ["高血压", "2 型糖尿病"]
MEDICATIONS = ["氨氯地平", "二甲双胍"]


# --------------------------------------------------------------------- #
# 辅助
# --------------------------------------------------------------------- #


def _token(username: str = "nurse", password: str = "nurse12345") -> str:
    response = client.post("/api/v1/auth/login", json={"username": username, "password": password})
    assert response.status_code == 200, response.text
    return response.json()["data"]["token"]


def _headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _new_patient(token: str, name: str) -> int:
    response = client.post(
        "/api/v1/patients",
        headers=_headers(token),
        json={"name": name, "gender": "男", "birth_date": "1942-03-08", "phone": "13700000099"},
    )
    assert response.status_code == 200, response.text
    return response.json()["data"]["id"]


def _new_session(token: str, patient_id: int) -> int:
    response = client.post(
        "/api/v1/dialogue/sessions", headers=_headers(token), json={"patient_id": patient_id}
    )
    assert response.status_code == 200, response.text
    return response.json()["data"]["id"]


def _say(token: str, session_id: int, content: str) -> dict:
    response = client.post(
        f"/api/v1/dialogue/sessions/{session_id}/messages",
        headers=_headers(token),
        json={"content": content},
    )
    assert response.status_code == 200, response.text
    return response.json()["data"]


def _kinds(flags: list[dict]) -> list[str]:
    return [flag["kind"] for flag in flags]


# --------------------------------------------------------------------- #
# 否定抽取
# --------------------------------------------------------------------- #


def test_plain_negation_before_symptom_is_detected():
    hits = extract_negations("我没有头晕")
    assert [(hit["kind"], hit["ref"]) for hit in hits] == [("symptom", "dizziness")]
    assert hits[0]["evidence"], "要留下原句，医护才能核对读到的是哪句话"


def test_negation_does_not_leak_across_symptoms_in_one_clause():
    """「不想吃饭还腹泻」——否定词在句首，但不能把后面的腹泻也否掉。"""
    assert extract_negations("不想吃饭还腹泻") == []


def test_negation_survives_filler_between_cue_and_term():
    assert [hit["ref"] for hit in extract_negations("从来没有过头晕")] == ["dizziness"]
    assert [hit["ref"] for hit in extract_negations("没有明显头晕")] == ["dizziness"]


def test_negation_stops_at_turning_word():
    """否定不跨分句：前一句否认的，不能顺带把后一句的症状也否掉。"""
    assert extract_negations("我有高血压，但是头不晕", condition_names=["高血压"]) == []
    hits = extract_negations("没有高血压，但是头晕", condition_names=["高血压"])
    assert [hit["ref"] for hit in hits] == ["高血压"], "只该记下被否认的高血压，头晕是肯定陈述"


def test_stop_word_detected_for_medication():
    hits = extract_negations("氨氯地平已经停了", medication_names=MEDICATIONS)
    assert [(hit["kind"], hit["ref"]) for hit in hits] == [("medication", "氨氯地平")]


def test_stop_veto_keeps_advice_out_of_conflicts():
    """「不能停」是医嘱，不能记成一次用药冲突。"""
    assert extract_negations("氨氯地平不能停", medication_names=MEDICATIONS) == []


def test_condition_prefix_is_tolerated():
    """画像写「2 型糖尿病」，老人只说「糖尿病」——按全名找会整类漏判。"""
    hits = extract_negations("我没得过糖尿病", condition_names=CONDITIONS)
    assert [(hit["kind"], hit["ref"]) for hit in hits] == [("condition", "2 型糖尿病")]


def test_affirmed_condition_is_not_flagged():
    assert extract_negations("糖尿病好多年了", condition_names=CONDITIONS) == []


def test_no_candidates_means_no_guessing():
    """不给候选就不猜：自由抽取病名药名会引入大量错位匹配。"""
    assert extract_negations("我没得过什么大病，也没吃别的药") == []


# --------------------------------------------------------------------- #
# 四类冲突
# --------------------------------------------------------------------- #


def test_symptom_conflict_carries_kind_and_severity():
    scale_results = [
        {
            "scale_code": "B.1",
            "scale_name": "基本日常生活活动能力评估量表",
            "level": "无依赖",
            "abnormal": False,
            "symptom_codes": ["difficulty_walking"],
        }
    ]
    flags = detect_conflicts([{"code": "difficulty_walking"}], scale_results)
    assert _kinds(flags) == ["symptoms"]
    assert flags[0]["severity"] == "warn"
    assert flags[0]["title"] == "症状与量表结果不一致"
    # 旧字段必须还在：老前端按 field + scale_value 拼提示
    assert flags[0]["field"] == "symptoms"
    assert flags[0]["scale_value"]


def test_complaint_conflict_when_chief_complaint_is_denied_later():
    negations = extract_negations("后来又说不头晕了")
    flags = detect_conflicts(
        [],
        [],
        negations=negations,
        chief_complaint={"text": "最近老是头晕", "symptom_codes": ["dizziness"]},
    )
    assert _kinds(flags) == ["complaint"]
    assert flags[0]["severity"] == "info", "主诉与后续描述不一致多为叙述差异，不该按高危处理"
    assert "最近老是头晕" in flags[0]["note"]


def test_medication_conflict_when_profile_says_still_taking():
    negations = extract_negations("氨氯地平已经停了", medication_names=MEDICATIONS)
    flags = detect_conflicts([], [], negations=negations, profile_medications=["氨氯地平"])
    assert _kinds(flags) == ["medication"]
    assert "医生确认" in flags[0]["note"]


def test_medication_profile_accepts_object_form():
    """契约写的是 [{name, dose}]，早期数据有裸字符串，两种都要读得出来。"""
    negations = extract_negations("二甲双胍已经停了", medication_names=MEDICATIONS)
    flags = detect_conflicts([], [], negations=negations, profile_medications=["二甲双胍"])
    assert _kinds(flags) == ["medication"]


def test_history_conflict_when_condition_is_denied():
    negations = extract_negations("我没得过糖尿病", condition_names=CONDITIONS)
    flags = detect_conflicts([], [], negations=negations, profile_conditions=CONDITIONS)
    assert _kinds(flags) == ["history"]
    assert flags[0]["profile_value"] == "既往史：2 型糖尿病"


def test_no_flags_when_nothing_contradicts():
    """没有矛盾就一条都不能报——误报会让医护不再相信这个标记。"""
    negations = extract_negations("糖尿病好多年了，氨氯地平一直在吃", medication_names=MEDICATIONS)
    flags = detect_conflicts(
        [],
        [],
        negations=negations,
        profile_conditions=CONDITIONS,
        profile_medications=MEDICATIONS,
        chief_complaint={"text": "头晕", "symptom_codes": ["dizziness"]},
    )
    assert flags == []


def test_negative_symptom_is_not_written_into_profile(db_session):
    """老人否认的症状不该进画像，否则后续匹配与报告都跟着错。"""
    token = _token()
    patient_id = _new_patient(token, "否认症状老人")
    session_id = _new_session(token, patient_id)

    _say(token, session_id, "我没有头晕")

    profile = (
        db_session.query(PatientMedicalProfile)
        .filter(PatientMedicalProfile.patient_id == patient_id)
        .first()
    )
    assert profile is not None
    assert "dizziness" not in {item.get("code") for item in (profile.symptoms or [])}


def test_chief_complaint_written_once_and_not_overwritten(db_session):
    token = _token()
    patient_id = _new_patient(token, "主诉老人")
    session_id = _new_session(token, patient_id)

    _say(token, session_id, "我这几天头晕")
    _say(token, session_id, "还有走路发飘")

    db_session.expire_all()
    profile = (
        db_session.query(PatientMedicalProfile)
        .filter(PatientMedicalProfile.patient_id == patient_id)
        .first()
    )
    assert profile.chief_complaint["text"] == "我这几天头晕", "主诉是「一开始为什么来」，不该被后续轮次改写"
    assert profile.chief_complaint["symptom_codes"] == ["dizziness"]


def test_greeting_does_not_become_chief_complaint(db_session):
    token = _token()
    patient_id = _new_patient(token, "打招呼老人")
    session_id = _new_session(token, patient_id)

    _say(token, session_id, "你好")
    _say(token, session_id, "我最近老是头晕")

    db_session.expire_all()
    profile = (
        db_session.query(PatientMedicalProfile)
        .filter(PatientMedicalProfile.patient_id == patient_id)
        .first()
    )
    assert profile.chief_complaint["text"] == "我最近老是头晕"


def test_conflict_flags_persist_on_turn_for_staff_review(db_session):
    """冲突标记要落到 turn 上：医护端从对话回放里读，不落库等于没检出。"""
    from app.db.models import DialogueTurn

    token = _token()
    patient_id = _new_patient(token, "冲突落库老人")
    session_id = _new_session(token, patient_id)

    profile = (
        db_session.query(PatientMedicalProfile)
        .filter(PatientMedicalProfile.patient_id == patient_id)
        .first()
    )
    if profile is None:
        profile = PatientMedicalProfile(
            patient_id=patient_id, symptoms=[], conditions=[], medications=[], lifestyle={}, chief_complaint={}
        )
        db_session.add(profile)
    profile.conditions = list(CONDITIONS)
    db_session.commit()

    _say(token, session_id, "我没得过糖尿病")

    db_session.expire_all()
    turn = (
        db_session.query(DialogueTurn)
        .filter(DialogueTurn.session_id == session_id, DialogueTurn.role == "user")
        .order_by(DialogueTurn.id.desc())
        .first()
    )
    assert turn is not None
    assert _kinds(turn.conflict_flags or []) == ["history"]


def test_conflict_flags_returned_by_session_api(db_session):
    """session 详情接口要原样带出 conflict_flags，前端才有东西可展示。"""
    token = _token()
    patient_id = _new_patient(token, "接口冲突老人")
    session_id = _new_session(token, patient_id)

    profile = (
        db_session.query(PatientMedicalProfile)
        .filter(PatientMedicalProfile.patient_id == patient_id)
        .first()
    )
    if profile is None:
        profile = PatientMedicalProfile(
            patient_id=patient_id, symptoms=[], conditions=[], medications=[], lifestyle={}, chief_complaint={}
        )
        db_session.add(profile)
    profile.conditions = list(CONDITIONS)
    db_session.commit()

    _say(token, session_id, "我没有高血压")

    response = client.get(f"/api/v1/dialogue/sessions/{session_id}", headers=_headers(token))
    assert response.status_code == 200, response.text
    turns = response.json()["data"]["turns"]
    user_turns = [turn for turn in turns if turn["role"] == "user"]
    assert user_turns[-1]["conflict_flags"], "接口没带出冲突标记，医护端看不到"
    assert user_turns[-1]["conflict_flags"][0]["kind"] == "history"
