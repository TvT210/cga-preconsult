"""大模型 Provider 的健壮性测试。

覆盖接真实模型时踩到的三个坑：
1. 推理模型把 `<think>…</think>` 思考过程写进正文 → 必须剥离；
2. 推理模型 token 预算耗尽时正文为空 → 必须显式报错，不能返回空串；
3. 模型异常不能拖垮主流程 → 降级为「请再说一遍」。

（这些用例不需要网络：用假 Provider 模拟各种返回。）
"""

from __future__ import annotations

import pytest

from packages.medagent.llm import (
    LLMEmptyResponse,
    OpenAICompatibleProvider,
    strip_think,
)


def test_strip_think_removes_closed_block():
    text = "<think>We need respond briefly</think>\n您好，最近哪里不舒服？"
    assert strip_think(text) == "您好，最近哪里不舒服？"


def test_strip_think_removes_unclosed_block():
    text = "<think>We need respond briefly\n没有结束标记"
    assert strip_think(text) == ""


def test_strip_think_keeps_normal_text():
    assert strip_think("请问您哪里不舒服？") == "请问您哪里不舒服？"


def test_strip_think_handles_empty():
    assert strip_think("") == ""


def test_openai_provider_raises_on_empty_content(monkeypatch):
    """正文为空（推理模型预算耗尽）→ 抛明确异常，而不是返回空串。"""
    provider = OpenAICompatibleProvider()
    provider.model = "test-model"
    provider.base_url = "http://127.0.0.1:1"
    provider.api_key = "x"

    class FakeResponse:
        status_code = 200

        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict:
            return {
                "choices": [{"finish_reason": "length", "message": {"content": ""}}]
            }

    class FakeClient:
        def __init__(self, *args, **kwargs) -> None:
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args) -> None:
            return None

        def post(self, *args, **kwargs):
            return FakeResponse()

    monkeypatch.setattr("packages.medagent.llm.httpx.Client", FakeClient)

    with pytest.raises(LLMEmptyResponse) as excinfo:
        provider.chat([{"role": "user", "content": "你好"}])
    assert "max_tokens" in str(excinfo.value)


def test_openai_provider_strips_think(monkeypatch):
    """带思考过程的返回，正文必须只剩正式回答。"""
    provider = OpenAICompatibleProvider()
    provider.model = "test-model"
    provider.base_url = "http://127.0.0.1:1"
    provider.api_key = "x"

    class FakeResponse:
        status_code = 200

        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict:
            return {
                "choices": [
                    {
                        "finish_reason": "stop",
                        "message": {
                            "content": "<think>思考过程</think>正式回答"
                        },
                    }
                ]
            }

    class FakeClient:
        def __init__(self, *args, **kwargs) -> None:
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args) -> None:
            return None

        def post(self, *args, **kwargs):
            return FakeResponse()

    monkeypatch.setattr("packages.medagent.llm.httpx.Client", FakeClient)
    assert provider.chat([{"role": "user", "content": "你好"}]) == "正式回答"


def test_dialogue_degrades_when_model_fails(monkeypatch):
    """模型异常 → 降级为「请再说一遍」，不抛错、不编造。"""
    from app.db.base import SessionLocal
    from app.services import dialogue as dialogue_service

    class Boom:
        name = "openai_compatible"
        model = "boom"

        def chat(self, *args, **kwargs):
            raise LLMEmptyResponse("预算耗尽")

    monkeypatch.setattr(dialogue_service, "get_provider", lambda: Boom())

    db = SessionLocal()
    try:
        patient = db.query(__import__("app.db.models", fromlist=["Patient"]).Patient).first()
        if patient is None:
            pytest.skip("演示患者不存在")
        session = dialogue_service.DialogueSession(patient_id=patient.id, title="t")
        db.add(session)
        db.commit()
        db.refresh(session)

        result = dialogue_service.run_dialogue_turn(db, session, "我头晕")
        assert "再说一遍" in result["reply"]
    finally:
        db.rollback()
        db.close()


def test_stream_chat_parses_openai_sse(monkeypatch):
    """OpenAI 兼容流式：逐行解析 `data:`，只取 delta.content，遇 [DONE] 停。"""

    lines = [
        'data: {"choices":[{"delta":{"content":"您好"}}]}',
        "",
        ": ping",  # 网关心跳/注释行，必须跳过
        'data: {"choices":[{"delta":{"content":"，我是"}}]}',
        'data: {"choices":[{"delta":{}}]}',  # 只有 role 没有正文的帧
        "data: [DONE]",
        'data: {"choices":[{"delta":{"content":"不该出现"}}]}',  # [DONE] 之后一律忽略
    ]

    class FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def iter_lines(self):
            return iter(lines)

        def __enter__(self):
            return self

        def __exit__(self, *args) -> None:
            return None

    class FakeClient:
        def __init__(self, *args, **kwargs) -> None:
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args) -> None:
            return None

        def stream(self, *args, **kwargs):
            return FakeResponse()

    monkeypatch.setattr("packages.medagent.llm.httpx.Client", FakeClient)
    provider = OpenAICompatibleProvider()
    pieces = list(provider.stream_chat([{"role": "user", "content": "你好"}]))
    assert "".join(pieces) == "您好，我是"


def test_stream_chat_skips_non_json_lines(monkeypatch):
    """网关偶尔混入非 JSON 行时不能炸掉整条流。"""

    lines = [
        "event: message",
        "data: not-json",
        'data: {"choices":[{"delta":{"content":"还在"}}]}',
        "data: [DONE]",
    ]

    class FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def iter_lines(self):
            return iter(lines)

        def __enter__(self):
            return self

        def __exit__(self, *args) -> None:
            return None

    class FakeClient:
        def __init__(self, *args, **kwargs) -> None:
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args) -> None:
            return None

        def stream(self, *args, **kwargs):
            return FakeResponse()

    monkeypatch.setattr("packages.medagent.llm.httpx.Client", FakeClient)
    assert "".join(OpenAICompatibleProvider().stream_chat([{"role": "user", "content": "hi"}])) == "还在"
