"""疾病库 v2 在真实服务上的验证脚本。

验证：28 病种入库、匹配结果带红旗/保护征象/高危因素、红旗托底提醒等级、
保护征象压低匹配度、免责声明与术语合规。
"""

from __future__ import annotations

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

        diseases = call("GET", "/diseases", headers=headers)
        print(f"[1] 疾病库：{len(diseases['diseases'])} 个病种，阈值 {len(diseases['thresholds'])} 条")
        new_codes = {"E16.2", "E11.5", "K56", "S72.0"}
        got = {item["code"] for item in diseases["diseases"]}
        print(f"    新增病种是否入库：{sorted(new_codes & got)}（缺 {sorted(new_codes - got)}）")

        detail = call("GET", "/diseases/K56", headers=headers)
        print(f"[2] K56 肠梗阻：高危因素 {len(detail['risk_factors'])} 条 / 红旗 {len(detail['red_flags'])} 条 / 鉴别 {len(detail['differentials'])} 条")

        # 场景一：老年人主诉「晕倒 + 胸口压得慌 + 喘不上气」→ 命中 I21 红旗，应托底为立即就医
        patient = call(
            "POST",
            "/patients",
            headers=headers,
            json={"name": "红旗测试老人", "gender": "男", "birth_date": "1942-02-02", "phone": "13500001111"},
        )
        call(
            "PUT",
            f"/patients/{patient['id']}/preconsult",
            headers=headers,
            json={"chief_complaint": {"text": "胸口压得慌、喘不上气、晕倒了一次"}, "history": {"conditions": ["高血压"]}},
        )
        match = call("POST", "/matching/run", headers=headers, json={"patient_id": patient["id"]})
        print(f"[3] 匹配批次 #{match['id']}：{len(match['candidates'])} 个候选")
        for candidate in match["candidates"][:3]:
            flags = "、".join(item["term"] for item in candidate.get("red_flags") or []) or "—"
            protect = "、".join(item["term"] for item in candidate.get("protective_signs") or []) or "—"
            distinctive = "、".join(item["term"] for item in candidate.get("distinctive_symptoms") or []) or "—"
            shared = "、".join(item["term"] for item in candidate.get("shared_symptoms") or []) or "—"
            patterns = "、".join(item["term"] for item in candidate.get("pattern_hits") or []) or "—"
            print(
                f"    #{candidate['rank']} {candidate['disease_name']}｜匹配度 {candidate['match_score']}"
                f"｜参考概率 {candidate['ref_probability']}"
            )
            print(f"        区分性症状：{distinctive}")
            print(f"        共享症状：{shared}")
            print(f"        症状组合命中：{patterns}")
            print(f"        红旗：{flags}｜保护征象：{protect}")
        alert = match["alert"]
        print(f"[4] 分级提醒：[{alert['level']}] {alert['message']}")
        print(f"    免责声明：{match['disclaimer']}")

        # 场景二：仅发热咳嗽（保护征象场景）→ 肺炎候选
        patient2 = call(
            "POST",
            "/patients",
            headers=headers,
            json={"name": "保护征象测试", "gender": "女", "birth_date": "1950-05-05"},
        )
        call(
            "PUT",
            f"/patients/{patient2['id']}/preconsult",
            headers=headers,
            json={"chief_complaint": {"text": "咳嗽、发烧、没力气"}, "history": {"conditions": []}},
        )
        match2 = call("POST", "/matching/run", headers=headers, json={"patient_id": patient2["id"]})
        print("[5] 仅发热咳嗽场景：")
        for candidate in match2["candidates"][:2]:
            protect = "、".join(item["term"] for item in candidate.get("protective_signs") or []) or "—"
            print(
                f"    #{candidate['rank']} {candidate['disease_name']}｜匹配度 {candidate['match_score']}"
                f"｜参考概率 {candidate['ref_probability']}｜保护征象：{protect}"
            )
        print(f"    提醒：[{match2['alert']['level']}] {match2['alert']['message'][:60]}")

        # 术语合规检查
        blob = str(match) + str(match2)
        banned = [term for term in ("确诊概率", "患病概率", "诊断为") if term in blob]
        print(f"[6] 术语红线：禁用词命中 {banned if banned else '无'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
