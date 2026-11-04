"""对话服务：症状抽取、安全边界与冲突标记。"""

from __future__ import annotations

from app.services.dialogue import check_safety, detect_conflicts, extract_symptoms


def test_extract_symptoms_maps_to_controlled_vocabulary():
    symptoms = extract_symptoms("我这几天头晕，走路发飘，还老想吐")
    codes = {item["code"] for item in symptoms}
    assert "dizziness" in codes
    assert "gait_instability" in codes
    assert "nausea_vomiting" in codes
    assert all(item["source"] == "dialogue" for item in symptoms)


def test_extract_symptoms_empty_for_irrelevant_text():
    assert extract_symptoms("今天天气不错") == []


def test_safety_rules_flag_emergency_presentation():
    assert "120" in check_safety("我胸口压得慌")
    assert "12356" in check_safety("我不想活了")
    assert check_safety("今天睡得挺好") == ""


def test_conflicts_are_flagged_but_not_overwritten():
    """对话提到量表关注症状、但量表结果未见异常时，标记冲突。"""
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
    assert flags, "应标记对话与量表结果不一致"
    assert "复核" in flags[0]["note"]


def test_no_conflict_when_scale_abnormal():
    scale_results = [
        {
            "scale_code": "B.1",
            "scale_name": "基本日常生活活动能力评估量表",
            "level": "中度依赖",
            "abnormal": True,
            "symptom_codes": ["difficulty_walking"],
        }
    ]
    assert detect_conflicts([{"code": "difficulty_walking"}], scale_results) == []
