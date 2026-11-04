"""端到端演示脚本（真实 HTTP 调用）。

流程：护士登录 → 读取量表 → 建患者 → 预问诊 → 知情同意 → 采集量表 → 自动判读
→ 医护复核 → 生成报告（Word/PDF）→ 触发匹配 → 查看分级提醒 → AI 对话 → 定期评估。
"""

from __future__ import annotations

import io
import json
import sys

import httpx

BASE = "http://127.0.0.1:8000/api/v1"


def call(client: httpx.Client, method: str, path: str, **kwargs) -> httpx.Response:
    response = client.request(method, f"{BASE}{path}", **kwargs)
    return response


def unwrap(response: httpx.Response):
    body = response.json()
    if body.get("code") != 0:
        raise SystemExit(f"接口失败 {response.request.method} {response.request.url}: {body}")
    return body["data"]


def main() -> int:
    with httpx.Client(timeout=30) as client:
        health = client.get("http://127.0.0.1:8000/health").json()
        print(f"[0] 健康检查: {health['status']}")

        nurse = unwrap(call(client, "POST", "/auth/login", json={"username": "nurse", "password": "nurse12345"}))
        nh = {"Authorization": f"Bearer {nurse['token']}"}
        doctor = unwrap(call(client, "POST", "/auth/login", json={"username": "doctor", "password": "doctor12345"}))
        dh = {"Authorization": f"Bearer {doctor['token']}"}
        elder = unwrap(call(client, "POST", "/auth/login", json={"username": "elder", "password": "elder12345"}))
        eh = {"Authorization": f"Bearer {elder['token']}"}
        print(f"[1] 登录成功：护士/医生/老人三端拿不到 token 之外的东西，老人绑定患者 P{elder['user']['patient_id']}")

        scales = unwrap(call(client, "GET", "/scales", headers=nh))
        ready = [s for s in scales if s["item_count"] > 0]
        print(f"[2] 量表中心：共 {len(scales)} 张，已录入条目 {len(ready)} 张 → {[s['code'] for s in ready]}")

        patient = unwrap(
            call(
                client,
                "POST",
                "/patients",
                headers=nh,
                json={
                    "name": "演示老人 李桂英",
                    "gender": "女",
                    "birth_date": "1947-09-20",
                    "phone": "13611112222",
                    "address": "示例社区幸福里 5 号楼 302",
                },
            )
        )
        print(f"[3] 建档：{patient['code']} {patient['name']} {patient['age']} 岁")

        preconsult = unwrap(
            call(
                client,
                "PUT",
                f"/patients/{patient['id']}/preconsult",
                headers=nh,
                json={
                    "basic": {"living_status": "独居", "education": "小学"},
                    "chief_complaint": {"text": "反复头晕，走路发飘", "onset": "5 天前", "severity": 3},
                    "history": {"conditions": ["高血压", "2 型糖尿病"], "medications": [{"name": "氨氯地平", "dose": "5mg qd"}]},
                    "lifestyle": {"falls": [{"time": "2026-10-28", "place": "卫生间"}], "sleep": "入睡困难"},
                },
            )
        )
        print(f"[4] 预问诊增量保存：既往病史 {preconsult['history']['conditions']}")

        consent = unwrap(call(client, "POST", f"/patients/{patient['id']}/consent", headers=nh, json={"agreed": True}))
        print(f"[5] 知情同意记录：#{consent['id']} agreed={consent['agreed']}")

        # 采集 B.1（Barthel ADL），模拟失能老人作答
        detail = unwrap(call(client, "GET", "/scales/B.1", headers=nh))
        session = unwrap(
            call(client, "POST", "/assessments", headers=nh, json={"patient_id": patient["id"], "scale_code": "B.1", "mode": "staff"})
        )
        print(f"[6] 建立评估任务 #{session['id']}（{detail['name']}，共 {session['total_questions']} 题）")

        picks = {
            "B1-01": "5", "B1-02": "0", "B1-03": "5", "B1-04": "5", "B1-05": "10",
            "B1-06": "5", "B1-07": "5", "B1-08": "5", "B1-09": "5", "B1-10": "0",
        }
        for question in detail["sections"][0]["questions"]:
            answer = unwrap(
                call(
                    client,
                    "POST",
                    f"/assessments/{session['id']}/answers",
                    headers=nh,
                    json={"question_code": question["code"], "value": picks.get(question["code"], "10"), "answered_by": "王护士"},
                )
            )
        print(f"[7] 作答完成：进度 {answer['progress']}/{session['total_questions']}")

        finished = unwrap(call(client, "POST", f"/assessments/{session['id']}/finish", headers=nh))
        score = finished["scores"][0]
        print(f"[8] 自动判读：总分 {score['total']} → {score['level']}｜{score['interpretation']}")
        print(f"    阳性标记：{[f['flag'] for f in score['flags']]}｜待人工确认：{score['needs_manual_review']}")
        print(f"    分支建议：{[(b['target_scale'], b['reason'][:24]) for b in finished['branches']]}")

        review = unwrap(
            call(client, "POST", f"/assessments/{session['id']}/review", headers=dh, json={"action": "approve", "comment": "复核一致"})
        )
        print(f"[9] 医护复核：状态 {review['status']}，复核后等级 {review['score']['level']}")

        report = unwrap(call(client, "POST", "/reports", headers=dh, json={"patient_id": patient["id"]}))
        print(f"[10] 生成报告 v{report['version']}：分区 {list(report['sections'].keys())}")
        docx = call(client, "GET", f"/reports/{report['id']}/export?format=docx", headers=dh)
        pdf = call(client, "GET", f"/reports/{report['id']}/export?format=pdf", headers=dh)
        print(f"[11] 导出：Word {len(docx.content)} 字节（{docx.content[:2]!r}）、PDF {len(pdf.content)} 字节（{pdf.content[:4]!r}）")

        match = unwrap(call(client, "POST", "/matching/run", headers=nh, json={"patient_id": patient["id"]}))
        print(f"[12] 匹配批次 #{match['id']}：返回 {len(match['candidates'])} 个候选")
        for candidate in match["candidates"][:3]:
            hits = "、".join(h["term"] for h in candidate["hit_symptoms"]) or "—"
            missing = "、".join(m["term"] for m in candidate["missing_symptoms"][:3]) or "—"
            print(
                f"    #{candidate['rank']} {candidate['disease_name']}｜匹配度 {candidate['match_score']}｜"
                f"参考概率 {candidate['ref_probability']}｜命中：{hits}｜缺失关键症状：{missing}"
            )
        print(f"[13] 分级提醒：[{match['alert']['level']}] {match['alert']['message']}")
        print(f"    免责声明：{match['disclaimer']}")

        session_dlg = unwrap(call(client, "POST", "/dialogue/sessions", headers=eh, json={"patient_id": elder["user"]["patient_id"]}))
        turn = unwrap(
            call(
                client,
                "POST",
                f"/dialogue/sessions/{session_dlg['id']}/messages",
                headers=eh,
                json={"content": "我这两天头晕，胸口闷，走路也晃"},
            )
        )
        print(f"[14] AI 对话：{turn['reply']}")
        print(f"    抽取症状：{[s['term'] for s in turn['extracted']['symptoms']]}｜安全提示：{turn['safety_note'] or '无'}")

        periodic = unwrap(call(client, "POST", "/periodic/run", headers=dh, json={"patient_id": patient["id"]}))
        print(f"[15] 定期自动评估：{periodic['notice']}")

        alerts = unwrap(call(client, "GET", f"/alerts?patient_id={patient['id']}", headers=nh))
        print(f"[16] 就医提醒 {len(alerts)} 条")

        metrics = unwrap(call(client, "GET", "/admin/stats/overview", headers=dh))
        print(f"[17] 看板：{json.dumps(metrics, ensure_ascii=False)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
