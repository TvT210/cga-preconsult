"""智能体 SDK：可插拔的大模型 Provider。

对业务层暴露统一接口 `chat()`；无 API Key 时使用 `mock` Provider，
接口、提示词版本与留痕字段与真实模型完全一致，便于演示与后续替换。
"""

from __future__ import annotations

import json
import time
from typing import Any, Protocol

import httpx

from app.core.config import settings


class LLMProvider(Protocol):
    name: str
    model: str

    def chat(self, messages: list[dict[str, str]], temperature: float = 0.3, max_tokens: int = 800) -> str: ...


class MockProvider:
    """确定性 mock：按关键词给出引导式追问，便于离线演示与自动化测试。"""

    name = "mock"

    def __init__(self) -> None:
        self.model = "mock-deterministic-v1"

    def chat(self, messages: list[dict[str, str]], temperature: float = 0.3, max_tokens: int = 800) -> str:
        user_text = ""
        for message in reversed(messages):
            if message.get("role") == "user":
                user_text = message.get("content", "")
                break
        return _mock_reply(user_text)


class OpenAICompatibleProvider:
    """OpenAI 兼容接口（可对接 MiniMax 等提供方的 /chat/completions）。"""

    name = "openai_compatible"

    def __init__(self) -> None:
        self.model = settings.llm_model or "gpt-4o-mini"
        self.base_url = settings.llm_base_url.rstrip("/")
        self.api_key = settings.llm_api_key

    def chat(self, messages: list[dict[str, str]], temperature: float = 0.3, max_tokens: int = 800) -> str:
        payload = {
            "model": self.model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": False,
        }
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        with httpx.Client(timeout=settings.llm_timeout) as client:
            response = client.post(f"{self.base_url}/chat/completions", json=payload, headers=headers)
            response.raise_for_status()
            data = response.json()
        return data["choices"][0]["message"]["content"]


def get_provider() -> LLMProvider:
    if settings.llm_provider == "openai_compatible" and settings.llm_base_url:
        return OpenAICompatibleProvider()
    return MockProvider()


_MOCK_RULES: list[tuple[tuple[str, ...], str]] = [
    (("头晕",), "您说的头晕大概持续多久了？有没有伴随视物模糊、说话不清或者手脚无力？"),
    (("胸", "心口", "憋气", "喘"), "胸口这种不舒服是休息时也有，还是活动以后出现？有没有出冷汗？"),
    (("咳",), "咳嗽是干咳还是有痰？痰是什么颜色，最近有没有发烧？"),
    (("疼", "痛"), "这个疼是一天比一天重，还是时好时坏？疼的部位能指给我看看吗？"),
    (("吃饭", "胃口", "不想吃", "吃不下"), "最近体重有没有下降？大概掉了多少？"),
    (("睡",), "入睡困难还是夜里容易醒？大概一晚上能睡几个小时？"),
    (("走路", "走", "腿软", "没劲"), "走路有没有觉得没力气或者摇晃？最近有没有摔倒过？"),
    (("忘", "记性", "记不住"), "记性变差是最近的事还是慢慢加重的？会不会经常重复问同样的问题？"),
    (("药",), "您现在每天都在吃哪些药？有没有漏吃或者自己停药的情况？"),
]


def _mock_reply(user_text: str) -> str:
    for keywords, reply in _MOCK_RULES:
        if any(keyword in user_text for keyword in keywords):
            return reply
    return "明白了，还有哪里不舒服吗？比如吃饭、睡觉、走路、用药这些方面。"


def timed_chat(
    provider: LLMProvider, messages: list[dict[str, str]], temperature: float = 0.3
) -> tuple[str, int]:
    """返回 (文本, 耗时毫秒)，用于 model_runs 留痕。"""
    started = time.perf_counter()
    text = provider.chat(messages, temperature=temperature)
    return text, int((time.perf_counter() - started) * 1000)


def dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)
