"""A-7 SSE 流式对话验证（线 A）。

覆盖点：
1. 增量能拼回全文，收尾事件带完整字段；
2. 收尾字段与非流式接口**完全一致**（这是 A-7 的验收标准）；
3. 急症提示在正文之前到达，不等到整段说完；
4. 一轮对话落两条 turn；
5. 模型不出字时降级为「请再说一遍」，不空回复、不编造；
6. Provider 没有流式能力时自动退化，仍能出字；
7. 思考过程的标签被切在多个 chunk 之间时也能剥干净；
8. 老人无权访问他人会话；
9. 客户端中途断开时，已说出的部分照样入库并标记中断。
"""

from __future__ import annotations

import json

from fastapi.testclient import TestClient

from app.api.dialogue import _stream_turn
from app.db.models import DialogueSession, DialogueTurn, User
from app.main import app
from app.services.dialogue import FALLBACK_REPEAT
from packages.medagent.llm import ThinkStreamFilter

client = TestClient(app)


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
        json={"name": name, "gender": "女", "birth_date": "1943-07-12", "phone": "13700000088"},
    )
    assert response.status_code == 200, response.text
    return response.json()["data"]["id"]


def _new_session(token: str, patient_id: int) -> int:
    response = client.post(
        "/api/v1/dialogue/sessions", headers=_headers(token), json={"patient_id": patient_id}
    )
    assert response.status_code == 200, response.text
    return response.json()["data"]["id"]


def _parse_sse(text: str) -> list[dict]:
    """把 SSE 原文解析成事件列表。只认 ``data:`` 行，与前端解析口径一致。"""
    events: list[dict] = []
    for block in text.split("\n\n"):
        block = block.strip()
        if not block.startswith("data:"):
            continue
        events.append(json.loads(block[len("data:") :].strip()))
    return events


def _stream(token: str, session_id: int, content: str) -> list[dict]:
    response = client.post(
        f"/api/v1/dialogue/sessions/{session_id}/messages/stream",
        headers=_headers(token),
        json={"content": content},
    )
    assert response.status_code == 200, response.text
    # 必须是事件流，不能被统一信封包成 JSON，否则前端逐字渲染无从谈起
    assert response.headers["content-type"].startswith("text/event-stream")
    return _parse_sse(response.text)


def _final(events: list[dict]) -> dict:
    finals = [event for event in events if event.get("done")]
    assert len(finals) == 1, f"收尾事件应恰好一个，实际 {len(finals)}"
    return finals[0]


# --------------------------------------------------------------------- #
# 正文与字段
# --------------------------------------------------------------------- #


def test_stream_deltas_concat_to_final_reply():
    """增量拼接必须等于收尾全文，否则前端显示的会和落库的不一致。"""
    token = _token()
    session_id = _new_session(token, _new_patient(token, "流式老人甲"))

    events = _stream(token, session_id, "我这几天头晕，走路发飘")
    deltas = [event for event in events if not event.get("done")]
    final = _final(events)

    assert len(deltas) >= 3, "mock 应按切片分多帧返回，一帧就失去流式的意义"
    assert "".join(event["reply"] for event in deltas) == final["reply"]
    assert final["reply"]


def test_stream_final_fields_match_non_stream():
    """收尾事件与非流式响应字段完全一致——A-7 的验收标准。"""
    token = _token()
    patient_id = _new_patient(token, "流式老人乙")
    content = "最近胃口不好，吃不下东西"

    stream_events = _stream(token, _new_session(token, patient_id), content)
    streamed = _final(stream_events)

    plain_session_id = _new_session(token, patient_id)
    plain = client.post(
        f"/api/v1/dialogue/sessions/{plain_session_id}/messages",
        headers=_headers(token),
        json={"content": content},
    ).json()["data"]

    assert set(streamed) - {"done"} == set(plain), "两条路径的字段集合必须一致"
    for key, value in plain.items():
        assert streamed[key] == value, f"字段 {key} 不一致：{streamed[key]!r} != {value!r}"


def test_stream_safety_note_arrives_before_reply():
    """急症提示不该等模型把话说完才出现。"""
    token = _token()
    session_id = _new_session(token, _new_patient(token, "流式老人丙"))

    events = _stream(token, session_id, "胸口压得慌，喘不上气")
    first = events[0]

    assert first["done"] is False
    assert first["safety_note"], "命中急症规则时首帧就要带安全提示"
    assert "reply" not in first, "首帧只负责告警，不应混入正文"

    # 收尾事件里同样带这条提示，前端刷新会话后仍能展示
    assert _final(events)["safety_note"] == first["safety_note"]


def test_stream_persists_both_turns(db_session):
    """流结束后一轮对话应落两条 turn，内容与推送一致。"""
    token = _token()
    session_id = _new_session(token, _new_patient(token, "流式老人丁"))

    events = _stream(token, session_id, "晚上睡不踏实")
    final = _final(events)

    turns = (
        db_session.query(DialogueTurn)
        .filter(DialogueTurn.session_id == session_id)
        .order_by(DialogueTurn.id.asc())
        .all()
    )
    assert [turn.role for turn in turns] == ["user", "assistant"]
    assert turns[0].content == "晚上睡不踏实"
    assert turns[1].content == final["reply"]
    assert turns[1].extracted == {}, "完整回复不应带中断标记"


# --------------------------------------------------------------------- #
# 降级与兼容
# --------------------------------------------------------------------- #


def test_stream_degrades_when_model_produces_nothing(monkeypatch):
    """模型一个字都没出：给「请再说一遍」，不能空回复、不能编。"""
    token = _token()
    session_id = _new_session(token, _new_patient(token, "流式老人戊"))

    class Silent:
        name = "openai_compatible"
        model = "silent-model"

        def chat(self, *args, **kwargs):
            return ""

        def stream_chat(self, *args, **kwargs):
            return iter(())

    monkeypatch.setattr("app.services.dialogue.get_provider", lambda: Silent())

    events = _stream(token, session_id, "我头晕")
    final = _final(events)

    assert final["reply"] == FALLBACK_REPEAT
    assert final["interrupted"] is False, "兜底话术是一条完整回复，不算中断"
    assert [event for event in events if not event["done"]] == []


def test_stream_falls_back_when_provider_has_no_streaming(monkeypatch):
    """Provider 只实现 chat 时也要能跑：退化为一次性返回，整体一帧吐出。"""
    token = _token()
    session_id = _new_session(token, _new_patient(token, "流式老人己"))

    class Legacy:
        name = "legacy"
        model = "legacy-model"

        def chat(self, messages, temperature=0.3, max_tokens=None):
            return "您好，请讲讲哪里不舒服。"

    monkeypatch.setattr("app.services.dialogue.get_provider", lambda: Legacy())

    events = _stream(token, session_id, "我头晕")
    deltas = [event for event in events if not event["done"]]
    final = _final(events)

    assert final["reply"] == "您好，请讲讲哪里不舒服。"
    assert "".join(event["reply"] for event in deltas) == final["reply"]
    assert final["model"] == "legacy-model"


def test_think_filter_handles_tags_split_across_chunks():
    """推理模型的思考过程可能被切成多块，标签本身就跨 chunk。"""
    cleaner = ThinkStreamFilter()
    pieces = ["<thi", "nk>内心", "推理过程", "</th", "ink>您好，我是"]
    text = "".join(cleaner.feed(piece) for piece in pieces) + cleaner.flush()
    assert text == "您好，我是"


def test_think_filter_keeps_lt_in_normal_text():
    """正文里的「小于」不能被当成标签开头吞掉。"""
    cleaner = ThinkStreamFilter()
    text = "".join(cleaner.feed(piece) for piece in ["血压 <", " 140 算正常"]) + cleaner.flush()
    assert text == "血压 < 140 算正常"


# --------------------------------------------------------------------- #
# 权限与中断
# --------------------------------------------------------------------- #


def test_stream_requires_patient_access():
    """老人不能借流式接口读他人会话。"""
    nurse_token = _token()
    session_id = _new_session(nurse_token, _new_patient(nurse_token, "流式老人庚"))

    elder_token = _token("elder", "elder12345")
    response = client.post(
        f"/api/v1/dialogue/sessions/{session_id}/messages/stream",
        headers=_headers(elder_token),
        json={"content": "你好"},
    )
    assert response.status_code == 403


def test_stream_rejects_empty_content():
    """空内容在推流之前就要挡掉：一旦开始推流状态码就固定 200 了。"""
    token = _token()
    session_id = _new_session(token, _new_patient(token, "流式老人辛"))

    response = client.post(
        f"/api/v1/dialogue/sessions/{session_id}/messages/stream",
        headers=_headers(token),
        json={"content": "   "},
    )
    assert response.status_code == 400


def test_client_disconnect_persists_partial_reply(db_session):
    """老人中途关页面：已说出的部分照样入库并标记中断，不补全。"""
    token = _token()
    session_id = _new_session(token, _new_patient(token, "流式老人壬"))

    session = db_session.get(DialogueSession, session_id)
    user = db_session.query(User).filter(User.username == "nurse").first()

    stream = _stream_turn(db_session, session, "我最近腿软", None, user)
    first_frame = next(stream)
    assert "reply" in json.loads(first_frame[len("data:") :].strip())

    stream.close()  # 模拟客户端断开，触发生成器的 finally

    turns = (
        db_session.query(DialogueTurn)
        .filter(DialogueTurn.session_id == session_id)
        .order_by(DialogueTurn.id.asc())
        .all()
    )
    assert [turn.role for turn in turns] == ["user", "assistant"]
    assert turns[0].content == "我最近腿软", "老人说过什么不能因为断线就丢"
    assert turns[1].content, "已经说出的那部分要留下来"
    assert turns[1].extracted == {"interrupted": True}, "半句回复必须标成中断"
