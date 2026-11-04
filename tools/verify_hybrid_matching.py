"""「程序 + AI」混合匹配与质控指标实机验证。"""

from __future__ import annotations

import json
import sys

import httpx

BASE = "http://127.0.0.1:8000/api/v1"


def main() -> int:
    with httpx.Client(timeout=30) as client:
        def call(method: str, path: str, **kwargs):
            response = client.request(method, f"{BASE}{path}", **kwargs)
            body = response.json()
            if body.get("code") != 0:
                raise SystemExit(f"{method} {path} 失败：{body}")
            return body["data"]

        nurse = call("POST", "/auth/login", json={"username": "nurse", "password": "nurse12345"})
        headers = {"Authorization": f"Bearer {nurse['token']}"}

        patient = call(
            "POST",
            "/patients",
            headers=headers,
            json={"name": "混合引擎验证", "gender": "男", "birth_date": "1941-08-08", "phone": "13700001234"},
        )
        call(
            "PUT",
            f"/patients/{patient['id']}/preconsult",
            headers=headers,
            json={
                "chief_complaint": {"text": "胸口压得慌、喘不上气、晕倒了一次，最近心慌"},
                "history": {"conditions": ["高血压", "2 型糖尿病"]},
                "lifestyle": {"sleep": "入睡困难"},
            },
        )

        run = call("POST", "/matching/run", headers=headers, json={"patient_id": patient["id"], "with_ai_review": True})
        print(f"[1] 匹配批次 #{run['id']}（程序 + AI 同时执行）")
        print(f"    规则排序：")
        for candidate in run["candidates"][:3]:
            distinctive = "、".join(item["term"] for item in candidate.get("distinctive_symptoms") or []) or "—"
            shared = "、".join(item["term"] for item in candidate.get("shared_symptoms") or []) or "—"
            print(
                f"      #{candidate['rank']} {candidate['disease_name']}｜匹配度 {candidate['match_score']}"
                f"｜参考概率 {candidate['ref_probability']}"
            )
            print(f"          区分性线索：{distinctive}｜共享症状：{shared}")
        print(f"    提醒：[{run['alert']['level']}] {run['alert']['message'][:70]}")

        review = run.get("ai_review")
        print(f"[2] AI 语义复核（模型 {review['model']}，{review['latency_ms']}ms）")
        print("    AI 建议排序：")
        for item in review["rerank"][:3]:
            print(f"      ai_rank {item['ai_rank']} {item['disease_name']}｜{item['rationale']}｜置信度 {item['confidence']}")
        print(f"    补充问诊建议：")
        for item in review["follow_ups"][:3]:
            print(f"      · {item['question']}（{item['reason'][:30]}）")
        print(f"    通俗解释示例：")
        for code, text in list(review["explanations"].items())[:2]:
            print(f"      {code}：{text[:60]}")
        if review["disagreements"]:
            print(f"    分歧提示：{review['disagreements'][0]['note']}")
        else:
            print("    分歧提示：本次规则与 AI 排序一致")

        fetched = call("GET", f"/matching/runs/{run['id']}/ai-review", headers=headers)
        print(f"[3] AI 复核记录可回查：#{fetched['id']}，提示词版本 {fetched['prompt_version']}")

        metrics = call("GET", "/admin/stats/overview", headers=headers)
        print(f"[4] 看板统计：{json.dumps(metrics, ensure_ascii=False)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
