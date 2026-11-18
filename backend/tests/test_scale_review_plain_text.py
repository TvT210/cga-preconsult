"""A-1 量表评审凭据落库 + A-4 题目口语化改写与审批回写（线 A）。

这一组用例守的是两条容易被"顺手做掉"却改变事实性质的线：

1. **签字人 ≠ 录入人**：外部专家没有系统账号时，代录的账号名不得写成评审人；
2. **候选 ≠ 已评审文案**：改写产出必须停在候选池，不能直接盖掉已评审的
   `plain_text`，也不能碰题号与计分。

另有两条回归用例：
- `get_scale` 曾用 `setdefault` 取评审态，题库 JSON 里写死的 draft 会盖住
  数据库里的 approved，表现为「评审完判读仍说待评审」；
- 批量评审重跑必须幂等，否则每点一次就堆一串同样的审批记录。
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.db.models import ScaleTemplate, ScaleVersion, TemplateApproval
from app.main import app
from app.services.scoring import AnswerRecord, evaluate_scale

client = TestClient(app)

ALL_CODES = [f"B.{index}" for index in range(1, 22)]

BASE_EVIDENCE = {
    "review_status": "approved",
    "reviewer": "王建民",
    "reviewer_title": "老年医学科 主任医师",
    "evidence_type": "verbal_confirmation",
    "comment": "2026-11-18 科室例会口头确认，按 WS/T 888—2026 附录 B 原文执行；书面签字件待补",
    "reviewed_at": "2026-11-18",
}


# --------------------------------------------------------------------- #
# 辅助
# --------------------------------------------------------------------- #


def _token(username: str = "doctor", password: str = "doctor12345") -> str:
    response = client.post("/api/v1/auth/login", json={"username": username, "password": password})
    assert response.status_code == 200, response.text
    return response.json()["data"]["token"]


def _headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _reset(db) -> None:
    """测试库是全量共享的，评审态必须复位，否则会泄漏到判读类用例。"""
    db.query(TemplateApproval).filter(
        TemplateApproval.target_type.in_(["scale", "scale_plain_text"])
    ).delete(synchronize_session=False)
    db.query(ScaleVersion).filter(ScaleVersion.comment.like("口语化文案回写%")).delete(
        synchronize_session=False
    )
    for row in db.query(ScaleTemplate).all():
        row.review_status = "draft_pending_medical_review"
        row.reviewer_name = ""
        row.reviewer_title = ""
        row.review_evidence = ""
        row.reviewed_at = None
        if row.payload and row.payload.get("plain_text_draft"):
            payload = dict(row.payload)
            payload.pop("plain_text_draft", None)
            row.payload = payload
    db.commit()


@pytest.fixture()
def reviews(db_session):
    _reset(db_session)
    yield db_session
    _reset(db_session)


# --------------------------------------------------------------------- #
# A-1：审批凭据
# --------------------------------------------------------------------- #


def test_review_requires_evidence_type(reviews):
    token = _token()
    payload = dict(BASE_EVIDENCE)
    payload.pop("evidence_type")
    response = client.put("/api/v1/scales/B.1/review", headers=_headers(token), json=payload)
    assert response.status_code == 400
    assert "凭据类型" in response.json()["message"]


def test_verbal_confirmation_requires_basis(reviews):
    token = _token()
    payload = dict(BASE_EVIDENCE)
    payload["comment"] = ""
    response = client.put("/api/v1/scales/B.1/review", headers=_headers(token), json=payload)
    assert response.status_code == 400
    assert "必须写明依据" in response.json()["message"]


def test_review_requires_signature_name(reviews):
    token = _token()
    payload = dict(BASE_EVIDENCE)
    payload["reviewer"] = ""
    response = client.put("/api/v1/scales/B.1/review", headers=_headers(token), json=payload)
    assert response.status_code == 400
    assert "签字人姓名" in response.json()["message"]


def test_review_requires_title_and_date(reviews):
    token = _token()
    payload = dict(BASE_EVIDENCE)
    payload["reviewer_title"] = ""
    response = client.put("/api/v1/scales/B.1/review", headers=_headers(token), json=payload)
    assert response.status_code == 400
    assert "职称" in response.json()["message"]

    payload = dict(BASE_EVIDENCE)
    payload["reviewed_at"] = ""
    response = client.put("/api/v1/scales/B.1/review", headers=_headers(token), json=payload)
    assert response.status_code == 400
    assert "签字日期" in response.json()["message"]


def test_reviewer_and_operator_are_recorded_separately(reviews):
    """本轮最核心的一条：签字人是王建民，录入人是登录的管理员。

    旧实现把两者混成一个字段，代录之后记录里就变成「同事已评审」。
    """
    token = _token("admin", "admin12345")
    response = client.put("/api/v1/scales/B.1/review", headers=_headers(token), json=BASE_EVIDENCE)
    assert response.status_code == 200, response.text
    assert response.json()["data"]["result"] == "applied"

    reviews.expire_all()
    approval = (
        reviews.query(TemplateApproval)
        .filter(TemplateApproval.target_id == "B.1")
        .order_by(TemplateApproval.id.desc())
        .first()
    )
    assert approval.reviewer == "王建民"
    assert approval.reviewer_title == "老年医学科 主任医师"
    assert approval.operator == "系统管理员"
    assert approval.evidence_type == "verbal_confirmation"
    assert approval.reviewer != approval.operator


def test_scale_detail_reads_status_from_database(reviews):
    """回归：题库 JSON 里写死 draft，评审后详情必须读到 approved。"""
    token = _token()
    client.put("/api/v1/scales/B.1/review", headers=_headers(token), json=BASE_EVIDENCE)

    detail = client.get("/api/v1/scales/B.1", headers=_headers(token)).json()["data"]
    assert detail["review_status"] == "approved"
    assert detail["review"]["reviewer_name"] == "王建民"
    assert detail["review"]["has_signed_document"] is False


def test_list_scales_exposes_evidence(reviews):
    token = _token()
    client.put("/api/v1/scales/B.1/review", headers=_headers(token), json=BASE_EVIDENCE)

    items = client.get("/api/v1/scales", headers=_headers(token)).json()["data"]
    target = next(item for item in items if item["code"] == "B.1")
    assert target["review_status"] == "approved"
    assert target["review_evidence"] == "verbal_confirmation"
    assert target["has_signed_document"] is False
    assert target["reviewed_at"].startswith("2026-11-18")


def test_batch_requires_explicit_codes(reviews):
    token = _token()
    response = client.post(
        "/api/v1/scales/reviews/batch", headers=_headers(token), json=dict(BASE_EVIDENCE, codes=[])
    )
    assert response.status_code == 400
    assert "不支持默认全部" in response.json()["message"]


def test_batch_review_all_scales(reviews):
    token = _token()
    response = client.post(
        "/api/v1/scales/reviews/batch",
        headers=_headers(token),
        json=dict(BASE_EVIDENCE, codes=ALL_CODES),
    )
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["total"] == 21
    assert data["applied"] == 21
    assert data["rejected"] == 0
    assert data["evidence_label"] == "口头/线上确认"

    reviews.expire_all()
    approved = reviews.query(ScaleTemplate).filter(ScaleTemplate.review_status == "approved").count()
    assert approved == 21


def test_batch_review_is_idempotent(reviews):
    token = _token()
    body = dict(BASE_EVIDENCE, codes=ALL_CODES)
    client.post("/api/v1/scales/reviews/batch", headers=_headers(token), json=body)
    reviews.expire_all()
    before = reviews.query(TemplateApproval).filter(TemplateApproval.target_type == "scale").count()

    again = client.post("/api/v1/scales/reviews/batch", headers=_headers(token), json=body)
    assert again.status_code == 200
    assert again.json()["data"]["unchanged"] == 21
    assert again.json()["data"]["applied"] == 0

    reviews.expire_all()
    after = reviews.query(TemplateApproval).filter(TemplateApproval.target_type == "scale").count()
    assert after == before


def test_batch_reports_unknown_code_per_item(reviews):
    token = _token()
    response = client.post(
        "/api/v1/scales/reviews/batch",
        headers=_headers(token),
        json=dict(BASE_EVIDENCE, codes=["B.1", "B.99"]),
    )
    assert response.status_code == 200
    data = response.json()["data"]
    assert data["applied"] == 1
    assert data["rejected"] == 1
    rejected = next(item for item in data["items"] if item["result"] == "rejected")
    assert rejected["code"] == "B.99"


def test_approval_records_are_queryable(reviews):
    token = _token()
    client.put("/api/v1/scales/B.2/review", headers=_headers(token), json=BASE_EVIDENCE)

    rows = client.get("/api/v1/scales/approvals?code=B.2", headers=_headers(token)).json()["data"]
    assert len(rows) == 1
    assert rows[0]["reviewer"] == "王建民"
    assert rows[0]["operator"] == "李医生"
    assert rows[0]["evidence_label"] == "口头/线上确认"


# --------------------------------------------------------------------- #
# A-1：判读提示按凭据分级
# --------------------------------------------------------------------- #


def _tiny_scale(evidence: str) -> dict:
    return {
        "code": "TX",
        "review_status": "approved",
        "review_evidence": evidence,
        "sections": [
            {
                "code": "S1",
                "questions": [
                    {
                        "code": "Q1",
                        "text": "题",
                        "input_type": "single",
                        "options": [
                            {"value": "1", "label": "是", "score": 1},
                            {"value": "0", "label": "否", "score": 0},
                        ],
                    }
                ],
            }
        ],
        "scoring": {
            "score": {"rule_type": "sum", "config": {"items": [{"code": "Q1"}]}},
            "levels": {
                "rule_type": "level_map",
                "config": {
                    "levels": [
                        {
                            "min": 0,
                            "max": 1,
                            "level": "正常",
                            "interpretation": "未见异常",
                            "abnormal": False,
                            "severity": "none",
                        }
                    ]
                },
            },
        },
    }


def _answer() -> dict[str, AnswerRecord]:
    return {"Q1": AnswerRecord(value="1", score=1)}


def test_verbal_evidence_keeps_manual_review_notice():
    result = evaluate_scale(_tiny_scale("verbal_confirmation"), _answer())
    assert result.needs_manual_review is True
    joined = " ".join(result.notices)
    assert "签字件待补" in joined
    assert "口头/线上确认" in joined
    # 不能再说「仅供演示」——它已经过评审，只是凭据不足
    assert "仅供演示" not in joined


def test_signed_evidence_clears_notice():
    result = evaluate_scale(_tiny_scale("signed_document"), _answer())
    assert result.needs_manual_review is False
    assert not any("签字件" in note for note in result.notices)


def test_draft_scale_still_marked_as_demo():
    scale = _tiny_scale("")
    scale["review_status"] = "draft_pending_medical_review"
    result = evaluate_scale(scale, _answer())
    assert result.needs_manual_review is True
    assert any("仅供演示" in note for note in result.notices)


# --------------------------------------------------------------------- #
# A-4：口语化改写与回写
# --------------------------------------------------------------------- #


def _plain_text_of(db, code: str, question_code: str) -> str:
    row = db.query(ScaleTemplate).filter(ScaleTemplate.code == code).first()
    for section in (row.payload or {}).get("sections") or []:
        for question in section.get("questions") or []:
            if question.get("code") == question_code:
                return question.get("plain_text") or ""
    raise AssertionError(f"题目不存在：{question_code}")


def _question_snapshot(db, code: str, question_code: str) -> dict:
    row = db.query(ScaleTemplate).filter(ScaleTemplate.code == code).first()
    for section in (row.payload or {}).get("sections") or []:
        for question in section.get("questions") or []:
            if question.get("code") == question_code:
                return question
    raise AssertionError(f"题目不存在：{question_code}")


def test_generate_candidates_does_not_touch_reviewed_text(reviews):
    token = _token()
    before = _plain_text_of(reviews, "B.1", "B1-01")

    response = client.post(
        "/api/v1/scales/B.1/plain-text/draft",
        headers=_headers(token),
        json={"question_codes": ["B1-01"]},
    )
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["count"] == 1

    reviews.expire_all()
    assert _plain_text_of(reviews, "B.1", "B1-01") == before

    draft = client.get("/api/v1/scales/B.1/plain-text/draft", headers=_headers(token)).json()["data"]
    assert draft["count"] == 1
    assert draft["items"][0]["question_code"] == "B1-01"
    assert draft["items"][0]["candidate"]


def test_generate_keeps_question_code_and_options(reviews):
    """改写只碰文案：题号、选项与分值必须一模一样。"""
    token = _token()
    before = _question_snapshot(reviews, "B.1", "B1-02")
    before_options = [dict(option) for option in before["options"]]

    client.post(
        "/api/v1/scales/B.1/plain-text/draft",
        headers=_headers(token),
        json={"question_codes": ["B1-02"]},
    )

    reviews.expire_all()
    after = _question_snapshot(reviews, "B.1", "B1-02")
    assert after["code"] == before["code"]
    assert after["options"] == before_options
    assert after.get("input_type") == before.get("input_type")


def test_apply_requires_approval_evidence(reviews):
    token = _token()
    client.post(
        "/api/v1/scales/B.1/plain-text/draft",
        headers=_headers(token),
        json={"question_codes": ["B1-01"]},
    )
    body = {
        "items": [{"question_code": "B1-01", "plain_text": "您自己吃饭能做到吗？"}],
        "reviewer": "王建民",
        "reviewer_title": "老年医学科 主任医师",
        "evidence_type": "verbal_confirmation",
        "comment": "",
        "reviewed_at": "2026-11-18",
    }
    response = client.post("/api/v1/scales/B.1/plain-text/apply", headers=_headers(token), json=body)
    assert response.status_code == 400
    assert "必须写明依据" in response.json()["message"]


def test_apply_promotes_candidate_and_records_version(reviews):
    token = _token()
    client.post(
        "/api/v1/scales/B.1/plain-text/draft",
        headers=_headers(token),
        json={"question_codes": ["B1-01"]},
    )
    body = {
        "items": [{"question_code": "B1-01", "plain_text": "您自己吃饭能做到吗？"}],
        "reviewer": "王建民",
        "reviewer_title": "老年医学科 主任医师",
        "evidence_type": "verbal_confirmation",
        "comment": "2026-11-18 口头确认，措辞通俗化不改题意",
        "reviewed_at": "2026-11-18",
    }
    response = client.post("/api/v1/scales/B.1/plain-text/apply", headers=_headers(token), json=body)
    assert response.status_code == 200, response.text
    assert response.json()["data"]["applied"] == 1

    reviews.expire_all()
    assert _plain_text_of(reviews, "B.1", "B1-01") == "您自己吃饭能做到吗？"

    draft = client.get("/api/v1/scales/B.1/plain-text/draft", headers=_headers(token)).json()["data"]
    assert draft["count"] == 0

    approval = (
        reviews.query(TemplateApproval)
        .filter(TemplateApproval.target_type == "scale_plain_text")
        .first()
    )
    assert approval is not None
    assert approval.reviewer == "王建民"
    assert approval.operator == "李医生"
    version = (
        reviews.query(ScaleVersion)
        .filter(ScaleVersion.comment.like("口语化文案回写%"))
        .first()
    )
    assert version is not None
    assert version.payload["changed_questions"] == ["B1-01"]


def test_apply_rejects_candidate_with_new_symptom(reviews):
    """护栏：改写引入原题干没有的症状词，必须在回写前挡住。

    这条比「能改」更重要——一句话读起来很顺、却多了个症状，审批人很难发现。
    """
    token = _token()
    body = {
        "items": [{"question_code": "B1-02", "plain_text": "您洗澡时会不会头晕摔倒？"}],
        "reviewer": "王建民",
        "reviewer_title": "老年医学科 主任医师",
        "evidence_type": "verbal_confirmation",
        "comment": "2026-11-18 口头确认",
        "reviewed_at": "2026-11-18",
    }
    response = client.post("/api/v1/scales/B.1/plain-text/apply", headers=_headers(token), json=body)
    assert response.status_code == 400
    assert "症状词" in response.json()["message"]


def test_apply_keeps_scoring_bindings(reviews):
    """回写后计分绑定不变：同一份作答算出的总分必须与回写前一致。"""
    token = _token()
    reviews.expire_all()
    before = _question_snapshot(reviews, "B.1", "B1-01")
    before_max = max(option.get("score", 0) for option in before["options"])

    body = {
        "items": [{"question_code": "B1-01", "plain_text": "您自己吃饭能做到吗？"}],
        "reviewer": "王建民",
        "reviewer_title": "老年医学科 主任医师",
        "evidence_type": "verbal_confirmation",
        "comment": "2026-11-18 口头确认",
        "reviewed_at": "2026-11-18",
    }
    client.post("/api/v1/scales/B.1/plain-text/apply", headers=_headers(token), json=body)

    reviews.expire_all()
    after = _question_snapshot(reviews, "B.1", "B1-01")
    assert [option["score"] for option in after["options"]] == [
        option["score"] for option in before["options"]
    ]
    assert max(option.get("score", 0) for option in after["options"]) == before_max


# --------------------------------------------------------------------- #
# A-1：评审台账（docs/structured/scale-approvals.json）启动时应用
# --------------------------------------------------------------------- #


def _write_ledger(tmp_path, approvals: list[dict]) -> None:
    target = tmp_path / "docs" / "structured"
    target.mkdir(parents=True, exist_ok=True)
    (target / "scale-approvals.json").write_text(
        __import__("json").dumps({"approvals": approvals}, ensure_ascii=False),
        encoding="utf-8",
    )


def test_seed_ledger_applies_approval(tmp_path, monkeypatch, reviews):
    """台账里有签字人 → 启动时应用，并留一条审批记录。"""
    import app.db.init_db as init_mod

    _write_ledger(
        tmp_path,
        [
            {
                "code": "B.3",
                "review_status": "approved",
                "reviewer": "王建民",
                "reviewer_title": "老年医学科 主任医师",
                "evidence_type": "verbal_confirmation",
                "reviewed_at": "2026-11-18",
                "comment": "2026-11-18 科室例会口头确认，签字件待补",
            }
        ],
    )
    monkeypatch.setattr(init_mod, "REPO_ROOT", tmp_path)
    init_mod.seed_scale_approvals(reviews)

    reviews.expire_all()
    row = reviews.query(ScaleTemplate).filter(ScaleTemplate.code == "B.3").first()
    assert row.review_status == "approved"
    assert row.reviewer_name == "王建民"
    assert row.review_evidence == "verbal_confirmation"
    assert row.reviewed_at is not None
    record = (
        reviews.query(TemplateApproval)
        .filter(TemplateApproval.target_id == "B.3")
        .first()
    )
    assert record.reviewer == "王建民"
    assert record.operator == "系统导入（评审台账）"


def test_seed_ledger_skips_entry_without_reviewer(tmp_path, monkeypatch, reviews):
    """没有签字人的条目直接跳过：宁可仍是草稿，也不写查不到责任人的记录。"""
    import app.db.init_db as init_mod

    _write_ledger(
        tmp_path,
        [
            {
                "code": "B.4",
                "review_status": "approved",
                "reviewer": "",
                "evidence_type": "verbal_confirmation",
                "reviewed_at": "2026-11-18",
            }
        ],
    )
    monkeypatch.setattr(init_mod, "REPO_ROOT", tmp_path)
    init_mod.seed_scale_approvals(reviews)

    reviews.expire_all()
    row = reviews.query(ScaleTemplate).filter(ScaleTemplate.code == "B.4").first()
    assert row.review_status == "draft_pending_medical_review"
    assert (
        reviews.query(TemplateApproval).filter(TemplateApproval.target_id == "B.4").count() == 0
    )


def test_seed_ledger_does_not_override_later_decision(tmp_path, monkeypatch, reviews):
    """已被人工改成 deprecated 的量表，重启不得被台账改回 approved。"""
    import app.db.init_db as init_mod

    reviews.query(ScaleTemplate).filter(ScaleTemplate.code == "B.5").update(
        {ScaleTemplate.review_status: "deprecated"}, synchronize_session=False
    )
    reviews.commit()

    _write_ledger(
        tmp_path,
        [
            {
                "code": "B.5",
                "review_status": "approved",
                "reviewer": "王建民",
                "reviewer_title": "老年医学科 主任医师",
                "evidence_type": "verbal_confirmation",
                "reviewed_at": "2026-11-18",
            }
        ],
    )
    monkeypatch.setattr(init_mod, "REPO_ROOT", tmp_path)
    init_mod.seed_scale_approvals(reviews)

    reviews.expire_all()
    row = reviews.query(ScaleTemplate).filter(ScaleTemplate.code == "B.5").first()
    assert row.review_status == "deprecated"


def test_seed_ledger_is_idempotent(tmp_path, monkeypatch, reviews):
    """重复启动不堆审批记录。"""
    import app.db.init_db as init_mod

    _write_ledger(
        tmp_path,
        [
            {
                "code": "B.6",
                "review_status": "approved",
                "reviewer": "王建民",
                "reviewer_title": "老年医学科 主任医师",
                "evidence_type": "verbal_confirmation",
                "reviewed_at": "2026-11-18",
            }
        ],
    )
    monkeypatch.setattr(init_mod, "REPO_ROOT", tmp_path)
    init_mod.seed_scale_approvals(reviews)
    init_mod.seed_scale_approvals(reviews)

    reviews.expire_all()
    assert (
        reviews.query(TemplateApproval).filter(TemplateApproval.target_id == "B.6").count() == 1
    )
