"""为关键症状补写「鉴别性追问话术」（probe）。

医生初诊的效率来自**追问细节**而不是记症状清单：症状相同要靠特征性细节区分。
本脚本为受控词表中的关键症状补写 probe 话术，供 AI 复核层生成鉴别性追问建议。

用法：python tools/add_symptom_probes.py [--check]
"""

from __future__ import annotations

import argparse
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
TARGET = ROOT / "docs" / "structured" / "disease-library" / "symptoms.json"

PROBES: dict[str, str] = {
    "chest_pain": "这个胸口的不舒服，是像被重东西压住一样的闷痛，还是像针扎一样的疼？是一直不停，还是歇一歇就好？",
    "dyspnea": "喘是在活动以后才出现，还是坐着不动也喘？平躺下来会不会比坐着更喘？",
    "orthopnea": "夜里睡觉是不是要垫高枕头才能喘过气来？平躺下来会憋醒吗？",
    "palpitations": "心慌是突然一下下跳快，还是一直跳得发慌？有没有伴着胸闷或出汗？",
    "fever": "发烧量过体温吗？大概多少度？有没有觉得发冷、打寒战？",
    "cough": "咳嗽是白天还是夜里更重？是干咳还是有痰？",
    "sputum": "痰是什么颜色的？黄绿色的痰多还是白痰多？",
    "dysarthria": "说话是含糊不清、口齿不利索，还是单个字说不出来？",
    "orientation_deficit": "现在是白天还是晚上？您能说说自己在哪儿、今天是什么时候吗？",
    "delirium_fluctuation": "这种糊涂是一整天都这样，还是一会儿清楚一会儿糊涂？跟昨天比怎么样？",
    "fatigue": "没力气是从什么时候开始的？早上起来能自己走动吗，还是得扶着东西？",
    "poor_appetite": "最近吃得少，是完全没有胃口，还是吃两口就饱了？一个月大概瘦了多少？",
    "weight_loss": "半年里体重有没有下降？是自己有意节食，还是没刻意减肥就瘦了？",
    "constipation": "大便一次间隔多久？最近有没有肚子胀或者放不出屁？",
    "abdominal_pain": "肚子疼在哪个位置？是胀着痛还是绞着痛？疼是一阵一阵还是一直疼？",
    "no_flatus_or_defecation": "最近还放屁吗？还有没有排过便？肚子胀不胀？",
    "dysuria": "小便的时候疼不疼？是尿得急、憋不住，还是排不出来？",
    "urinary_retention": "小便要等一会儿才出来吗？尿线是不是变细了？夜里要起来几次？",
    "hemoptysis": "咯出来的血是什么颜色？大约几口？有没有混着泡沫？",
    "melena": "大便发黑是柏油样的吗？有没有同时觉得头晕没力气？",
    "edema": "腿是早上肿还是下午肿？按下去凹个坑吗？平躺一晚上能消吗？",
    "syncope": "晕倒的时候有没有自己撞到东西？醒过来后头疼吗？",
    "dizziness": "头晕是转圈还是发飘？有没有站不稳、差点摔倒？",
    "tremor": "手抖是拿东西的时候抖，还是安静时也抖？",
    "bradykinesia": "走路是不是越来越慢、步子越来越小？有没有拖步的感觉？",
    "rigidity": "身体发不发抖硬？别人帮您转身时费力吗？",
    "memory_decline": "忘事是最近开始的还是慢慢加重？会不会刚说过的话就忘了？",
    "hypoglycemia_symptom": "心慌出汗的时候，脑子里是不是发懵、手脚没劲？吃东西能不能缓过来？",
    "ketone_breath": "最近有没有觉得嘴里发苦、呼气像烂苹果的味道？",
    "deep_breathing": "喘气的时候是不是又深又快，自己都控制不住？",
    "nocturia": "夜里要起来上厕所几次？每次尿量多不多？",
    "aspiration_risk": "喝水或吃饭的时候有没有呛过？呛到以后会咳多久？",
    "dysphagia": "喝水顺不顺？吃干的东西是不是要喝很多水才咽得下？",
    "fall_injury": "这次摔倒后哪里疼？能自己站起来吗？当时有没有撞到头？",
    "hip_pain": "疼的是大腿根还是膝盖附近？躺着和坐着哪个更疼？",
    "joint_swelling": "关节肿起来了吗？早上起来关节僵不僵，僵多久？",
    "morning_stiffness": "早上起床关节僵不僵？大概僵多长时间能活动开？",
    "urinary_appearance_change": "小便有没有变浑浊、变臭或者颜色不一样？",
}


def main() -> int:
    parser = argparse.ArgumentParser(description="补写症状鉴别性追问话术")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()

    data = json.loads(TARGET.read_text(encoding="utf-8"))
    added = 0
    for item in data["symptoms"]:
        probe = PROBES.get(item["code"])
        if probe and not item.get("probe"):
            item["probe"] = probe
            added += 1
    print(f"新增 probe 话术 {added} 条")
    if args.check:
        print("（--check 模式，未写盘）")
        return 0
    data["version"] = "0.3.0-draft"
    TARGET.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"已写入 {TARGET}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
