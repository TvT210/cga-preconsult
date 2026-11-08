"""AI 复核层：规则引擎之外的语义消歧、追问建议与通俗解释。

## 为什么要「程序 + AI」

规则引擎擅长**可审计的确定性**：召回、加权、鉴别扣分、红旗托底、阈值判定。
但它不擅长**语义消歧**——「胸闷 + 气促 + 高血压病史」到底偏向急性心肌梗死还是
高血压急症，需要临床语义推理；而「乏力 + 纳差 + 脑子糊涂」在老年人身上，
可能是感染、可能是谵妄、也可能是电解质紊乱，规则难以区分。

因此本模块的分工是：

| 环节 | 由谁决定 | 说明 |
| --- | --- | --- |
| 候选召回、加权打分、鉴别扣分、红旗托底、阈值判定 | **程序（规则引擎）** | 可复现、可审计、可回溯 |
| 候选之间的语义消歧与排序建议 | **AI** | 只给建议，不改分值 |
| 缺什么信息、该追问什么 | **AI** | 输出追问建议清单 |
| 提醒等级 | **程序** | AI 不得改写（红线） |
| 结论确认 | **医护** | AI 建议需人工采纳 |

## 红线（硬约束）

1. AI **不出诊断结论**，不输出「患 XX 病」这类表述；
2. AI **不改匹配度分值、参考概率、阈值、提醒等级**——这些一律由程序决定；
3. AI 的排序建议**不覆盖**规则排序，两者并列展示，由医护裁决；
4. AI 产出一律标注来源（模型、提示词版本、耗时），可追溯；
5. 全部输出必须带「仅供参考，不构成诊断」声明。

## 离线可用

`llm_provider = mock`（默认，无 API Key）时走**确定性模拟**：用可解释的启发式
生成重排建议、追问清单与通俗解释，保证没有网络/密钥也能演示与测试。
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy.orm import Session

from app.db.models import MatchAiReview, ModelRun
from app.services.prompt_store import PROMPT_CODE_MATCH_REVIEW, resolve_prompt
from packages.medagent.llm import get_provider

AI_REVIEW_PROMPT_VERSION = "0.1.0-draft"

DISCLAIMER = "AI 复核意见仅供参考，不构成诊断，请以医师判断为准。"

SYSTEM_PROMPT = (
    "你是老年综合评估系统的辅助复核助手，负责在规则引擎给出的候选基础上做**语义消歧**。\n"
    "严格遵守：\n"
    "1. 不得给出诊断结论，不得使用「确诊」「患XX病」「一定是XX病」等表述；\n"
    "2. 不得修改任何分值、阈值或提醒等级，只给建议；\n"
    "3. 只依据给出的证据作答，证据不足时必须明说「证据不足」；\n"
    "4. 用简体中文，输出严格 JSON，不要任何额外文字或 Markdown 代码块。\n"
    "输出 JSON 结构：\n"
    '{"rerank":[{"disease_code":"...","ai_rank":1,"rationale":"...","confidence":"high|medium|low"}],'
    '"follow_ups":[{"question":"向老人追问的原话问题","reason":"为什么需要问","priority":"high|medium|low"}],'
    '"explanations":{"disease_code":"给老人听的通俗说明"},"disagreements":[{"disease_code":"...",'
    '"rule_view":"规则引擎怎么看","ai_view":"你补充的判断","note":"..."}]}'
)


@dataclass
class AiReview:
    rerank: list[dict] = field(default_factory=list)
    follow_ups: list[dict] = field(default_factory=list)
    explanations: dict[str, str] = field(default_factory=dict)
    disagreements: list[dict] = field(default_factory=list)
    model: str = ""
    prompt_version: str = AI_REVIEW_PROMPT_VERSION
    latency_ms: int = 0
    raw_output: str = ""
    notice: str = DISCLAIMER

    def to_dict(self) -> dict[str, Any]:
        return {
            "rerank": self.rerank,
            "follow_ups": self.follow_ups,
            "explanations": self.explanations,
            "disagreements": self.disagreements,
            "model": self.model,
            "prompt_version": self.prompt_version,
            "latency_ms": self.latency_ms,
            "notice": self.notice,
        }


def _extract_json(text: str) -> dict[str, Any] | None:
    """从模型输出中提取 JSON（容忍代码块与前后缀说明）。"""
    if not text:
        return None
    cleaned = text.strip()
    cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
    cleaned = re.sub(r"\s*```$", "", cleaned).strip()
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return None
    try:
        return json.loads(cleaned[start : end + 1])
    except json.JSONDecodeError:
        return None


def _build_payload(
    patient: dict,
    evidence: dict,
    candidates: list[dict],
    disease_profiles: dict[str, dict],
) -> dict[str, Any]:
    """构造给模型的输入快照（已裁剪，避免超长与无关信息）。"""
    trimmed_candidates = []
    for candidate in candidates:
        code = candidate.get("disease_code", "")
        profile = disease_profiles.get(code, {})
        trimmed_candidates.append(
            {
                "disease_code": code,
                "disease_name": candidate.get("disease_name", ""),
                "match_score": candidate.get("match_score"),
                "ref_probability": candidate.get("ref_probability"),
                "hit_symptoms": [item.get("term") for item in candidate.get("hit_symptoms", [])],
                "missing_core_symptoms": [
                    item.get("term")
                    for item in candidate.get("missing_symptoms", [])
                    if item.get("weight") == "core"
                ],
                "red_flags": [item.get("term") for item in candidate.get("red_flags", [])],
                "atypical_presentations": (profile.get("atypical_presentations") or [])[:3],
                "key_differentials": [
                    f"vs {item.get('vs_code')}：{item.get('reason', '')}"
                    for item in (profile.get("differentials") or [])[:2]
                ],
            }
        )
    return {
        "patient": {
            "name": patient.get("name", ""),
            "age": patient.get("age"),
            "gender": patient.get("gender", ""),
            "chief_complaint": patient.get("chief_complaint", ""),
            "history": patient.get("history", []),
        },
        "evidence": {
            "symptoms": [item.get("term") for item in evidence.get("symptoms", [])],
            "conditions": patient.get("history", []),
        },
        "candidates": trimmed_candidates,
    }


def _mock_review(payload: dict, candidates: list[dict]) -> AiReview:
    """离线确定性模拟：按可解释启发式生成 AI 复核意见。

    启发式（与临床直觉一致，非医学结论）：
    - 命中红旗征的候选优先级更高；
    - 命中核心症状更多的候选，语义上更贴合；
    - 缺失核心症状多的候选，需要补充问诊。
    """
    rerank = []
    for candidate in candidates:
        code = candidate.get("disease_code", "")
        red_flags = candidate.get("red_flags") or []
        core_hits = sum(
            1 for item in candidate.get("hit_symptoms", []) if item.get("weight") == "core"
        )
        score = candidate.get("match_score", 0) or 0
        priority = (len(red_flags) * 100) + core_hits * 10 + score / 100
        confidence = "high" if red_flags else ("medium" if core_hits >= 2 else "low")
        rationale = (
            f"命中 {len(red_flags)} 项急症红旗征"
            if red_flags
            else (f"命中 {core_hits} 项核心症状" if core_hits else "仅有非核心症状支持")
        )
        rerank.append(
            {
                "disease_code": code,
                "disease_name": candidate.get("disease_name", ""),
                "_priority": priority,
                "rationale": rationale,
                "confidence": confidence,
            }
        )
    rerank.sort(key=lambda item: -item.pop("_priority"))
    for index, item in enumerate(rerank, start=1):
        item["ai_rank"] = index

    follow_ups: list[dict] = []
    top = rerank[0] if rerank else None
    if top:
        top_candidate = next(
            (c for c in candidates if c.get("disease_code") == top["disease_code"]), None
        )
        if top_candidate:
            # ① 优先追问「缺失的核心症状」——这是最直接的证据缺口
            for missing in top_candidate.get("missing_symptoms", [])[:3]:
                if missing.get("weight") != "core":
                    continue
                follow_ups.append(
                    {
                        "question": f"老人有没有出现「{missing.get('term', '')}」这样的表现？",
                        "reason": f"「{missing.get('term', '')}」是本病的关键线索，缺失会影响判断的把握",
                        "priority": "high" if len(follow_ups) < 2 else "medium",
                        "kind": "missing_core",
                    }
                )
            # ② 若核心症状已齐但命中多为共享症状 → 追问特征细节做鉴别
            if not follow_ups:
                for shared in top_candidate.get("shared_symptoms", [])[:2]:
                    probe = shared.get("probe") or ""
                    if not probe:
                        continue
                    follow_ups.append(
                        {
                            "question": probe,
                            "reason": f"「{shared.get('term', '')}」在多个疾病中都会出现，需要问清特征才能区分",
                            "priority": "high" if len(follow_ups) < 1 else "medium",
                            "kind": "differential_probe",
                        }
                    )
            # ③ 兜底：追问红旗征相关的确认细节
            if not follow_ups:
                for flag in top_candidate.get("red_flags", [])[:1]:
                    follow_ups.append(
                        {
                            "question": f"请确认一下：{flag.get('term', '')} 是什么时候开始的？现在还有吗？",
                            "reason": f"红旗征「{flag.get('term', '')}」需要确认起始时间与当前状态",
                            "priority": "high",
                            "kind": "red_flag_confirm",
                        }
                    )

    explanations: dict[str, str] = {}
    payload_profiles = {
        item.get("disease_code", ""): item for item in payload.get("candidates", []) or []
    }
    for candidate in candidates[:3]:
        code = candidate.get("disease_code", "")
        profile = payload_profiles.get(code, {})
        atypical = (profile.get("atypical_presentations") or [])[:1]
        advice = (candidate.get("advice") or {}).get("text", "")
        explanations[code] = (
            (f"（{atypical[0]}）" if atypical else "") + (advice or "本次评估提示需要进一步观察。")
        )

    disagreements = []
    if candidates and rerank and candidates[0].get("disease_code") != rerank[0].get("disease_code"):
        disagreements.append(
            {
                "disease_code": rerank[0].get("disease_code", ""),
                "rule_view": f"规则排序第一为 {candidates[0].get('disease_name', '')}",
                "ai_view": f"语义上更倾向 {rerank[0].get('disease_name', '')}",
                "note": "规则与语义判断不一致，请医师复核后决定是否采纳",
            }
        )

    return AiReview(
        rerank=rerank,
        follow_ups=follow_ups,
        explanations=explanations,
        disagreements=disagreements,
        model="mock-deterministic-v1",
        prompt_version=AI_REVIEW_PROMPT_VERSION,
    )


def review_match(
    db: Session,
    run,
    patient: dict,
    evidence: dict,
    candidates: list[dict],
    disease_profiles: dict[str, dict],
) -> AiReview:
    """对一次匹配批次执行 AI 复核，落库并留痕。"""
    payload = _build_payload(patient, evidence, candidates, disease_profiles)
    provider = get_provider()
    # 提示词优先取 prompt_templates 表里的生效版本（运营可改），没有则用内置版本
    system_prompt, prompt_version = resolve_prompt(
        db, PROMPT_CODE_MATCH_REVIEW, SYSTEM_PROMPT, AI_REVIEW_PROMPT_VERSION
    )

    started = time.perf_counter()
    if getattr(provider, "name", "") == "mock":
        review = _mock_review(payload, candidates)
        review.prompt_version = prompt_version
    else:
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
        ]
        try:
            text = provider.chat(messages, temperature=0.2)
        except Exception as exc:  # 模型异常不阻断匹配主流程：降级为「无 AI 意见」
            review = AiReview(
                model=getattr(provider, "model", "unknown"),
                prompt_version=prompt_version,
                notice=f"{DISCLAIMER}（AI 复核未完成：{type(exc).__name__}）",
            )
            text = ""
        else:
            parsed = _extract_json(text) or {}
            review = AiReview(
                rerank=parsed.get("rerank") or [],
                follow_ups=parsed.get("follow_ups") or [],
                explanations=parsed.get("explanations") or {},
                disagreements=parsed.get("disagreements") or [],
                model=getattr(provider, "model", "unknown"),
                prompt_version=prompt_version,
                raw_output=text[:4000],
            )
    review.latency_ms = int((time.perf_counter() - started) * 1000)

    record = MatchAiReview(
        run_id=run.id,
        patient_id=run.patient_id,
        model=review.model,
        prompt_version=review.prompt_version,
        input_snapshot=payload,
        output=review.to_dict(),
        latency_ms=review.latency_ms,
    )
    db.add(record)
    db.add(
        ModelRun(
            task="match_ai_review",
            model=review.model,
            prompt_version=review.prompt_version,
            latency_ms=review.latency_ms,
            input_snapshot=payload,
            output_snapshot=review.to_dict(),
        )
    )
    db.commit()
    db.refresh(record)
    review.raw_output = record.output.get("raw_output", "") if isinstance(record.output, dict) else ""
    return review
