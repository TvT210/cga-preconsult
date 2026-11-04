"""数据库初始化与种子数据。

幂等：重复执行不会重复插入。种子数据包含预置账号、21 张量表题库、疾病库、
阈值与匹配权重、提示词模板，以及一位演示患者。
"""

from __future__ import annotations

import datetime as dt
import json

from sqlalchemy.orm import Session

from app.core.config import REPO_ROOT
from app.core.security import hash_password
from app.db.base import Base, SessionLocal, engine
from app.db.models import (
    AlertThreshold,
    Consent,
    DiseaseDifferential,
    DiseaseProfile,
    DiseaseSymptom,
    MatchingRule,
    Patient,
    PatientMedicalProfile,
    Preconsult,
    PromptTemplate,
    ReportTemplate,
    ScaleTemplate,
    ScaleVersion,
    User,
)
from app.services.disease_library import load_disease_file
from app.services.scales_store import load_scale_files

DEFAULT_USERS = [
    ("admin", "admin12345", "系统管理员", "admin", "信息科"),
    ("doctor", "doctor12345", "李医生", "doctor", "老年医学科"),
    ("nurse", "nurse12345", "王护士", "staff", "护理部"),
    ("elder", "elder12345", "张桂芳（演示）", "elder", ""),
]

PROMPT_TEMPLATES = [
    (
        "dialogue_guide",
        "预问诊引导式对话",
        "你是老年人就医前预问诊助手，围绕主诉、用药、饮食、睡眠、活动、情绪逐项引导，"
        "每次只问一个问题；不诊断、不调药；出现急症表述立即提示就医。",
    ),
    (
        "periodic_assessment",
        "定期自动评估（AI 补充）",
        "仅依据专属医疗数据库已有信息，按四个维度输出补充性结论与趋势，"
        "标注「AI 补充评估」，不得虚构未采集内容。",
    ),
    (
        "match_explain",
        "候选疾病通俗说明",
        "用通俗语言解释候选疾病，表述使用「匹配度」「参考概率」，"
        "禁止使用「确诊概率」「患病概率」，不得给出治疗方案。",
    ),
    (
        "match_ai_review",
        "匹配结果 AI 语义复核",
        "在规则引擎给出的候选基础上做语义消歧：给出排序建议、补充问诊清单、"
        "通俗解释与分歧说明；不得给出诊断结论，不得修改分值、阈值或提醒等级。",
    ),
]


def create_tables() -> None:
    Base.metadata.create_all(bind=engine)
    _sync_missing_columns()


def _sync_missing_columns() -> None:
    """轻量迁移：为已存在的库补齐新增字段（Alembic 落地前的过渡方案）。

    create_all 不会给既有表加列，这里比对模型与实际列，缺失的补上。
    """
    from sqlalchemy import inspect, text

    inspector = inspect(engine)
    existing_tables = set(inspector.get_table_names())
    with engine.begin() as connection:
        for table in Base.metadata.tables.values():
            if table.name not in existing_tables:
                continue
            actual = {column["name"] for column in inspector.get_columns(table.name)}
            for column in table.columns:
                if column.name in actual:
                    continue
                ddl = f"ALTER TABLE {table.name} ADD COLUMN {column.name} {column.type.compile(dialect=engine.dialect)}"
                try:
                    connection.execute(text(ddl))
                except Exception:  # pragma: no cover - 权限或方言差异时忽略
                    pass


def seed_users(db: Session) -> None:
    if db.query(User).count() > 0:
        return
    demo_patient = db.query(Patient).filter(Patient.code == "P0001").first()
    for username, password, full_name, role, department in DEFAULT_USERS:
        user = User(
            username=username,
            password_hash=hash_password(password),
            full_name=full_name,
            role=role,
            department=department,
        )
        if role == "elder" and demo_patient:
            user.patient_id = demo_patient.id
        db.add(user)
    db.commit()


def seed_patient(db: Session) -> None:
    if db.query(Patient).count() > 0:
        return
    patient = Patient(
        code="P0001",
        name="张桂芳",
        gender="女",
        birth_date=_date(1948, 5, 12),
        phone="13800000001",
        id_card_masked="440***********1234",
        address="示例社区幸福里 3 号楼 201",
        emergency_contact="邱某（女儿） 13900000002",
    )
    db.add(patient)
    db.commit()
    db.add(
        Preconsult(
            patient_id=patient.id,
            payload={
                "basic": {
                    "gender": "女",
                    "birth_date": "1948-05-12",
                    "marital_status": "丧偶",
                    "education": "小学",
                    "living_status": "独居",
                    "medical_insurance": "职工医保",
                    "contact_name": "邱某",
                    "contact_phone": "13900000002",
                },
                "chief_complaint": {
                    "text": "反复头晕 3 天，伴走路不稳",
                    "onset": "3 天前",
                    "site": "头部",
                    "nature": "昏沉",
                    "severity": 3,
                    "course": "间断",
                    "associated": ["乏力", "走路摇晃"],
                },
                "history": {
                    "conditions": ["高血压", "2 型糖尿病"],
                    "medications": [
                        {"name": "氨氯地平", "dose": "5mg 每日一次", "since": "2023-05"},
                        {"name": "二甲双胍", "dose": "0.5g 每日两次", "since": "2022-11"},
                    ],
                    "allergies": [{"name": "青霉素", "reaction": "皮疹"}],
                },
                "lifestyle": {
                    "smoking": False,
                    "drinking": False,
                    "diet": "普通饮食",
                    "activity": "每日散步 20 分钟",
                    "sleep": "入睡困难，约 4 小时",
                    "falls": [
                        {"time": "2026-10-20", "place": "卫生间", "cause": "地面湿滑", "injury": "轻微擦伤"}
                    ],
                },
                "proxy": {"is_proxy": False, "proxy_name": "", "proxy_relation": ""},
            },
        )
    )
    db.add(PatientMedicalProfile(patient_id=patient.id, symptoms=[], conditions=["高血压", "2 型糖尿病"], medications=[], lifestyle={}, chief_complaint={}))
    db.add(Consent(patient_id=patient.id, agreed=True, scope="评估、报告生成与就医提醒", ai_involved=True))
    db.commit()


def _date(year: int, month: int, day: int):
    import datetime as dt

    return dt.date(year, month, day)


def seed_scales(db: Session) -> None:
    for code, payload in load_scale_files().items():
        row = db.query(ScaleTemplate).filter(ScaleTemplate.code == code).first()
        if row is None:
            row = ScaleTemplate(
                code=code,
                name=payload.get("name", code),
                dimension=payload.get("dimension", ""),
                method=payload.get("method", ""),
                standard_ref=payload.get("standard_ref", ""),
                version=payload.get("version", "0.1.0-draft"),
                review_status=payload.get("review_status", "draft_pending_medical_review"),
                payload=payload,
            )
            db.add(row)
        if not db.query(ScaleVersion).filter(ScaleVersion.scale_code == code).first():
            db.add(
                ScaleVersion(
                    scale_code=code,
                    version=payload.get("version", "0.1.0-draft"),
                    payload=payload,
                    reviewer="系统导入",
                    comment="从 docs/structured 导入的基线版本（待评审）",
                )
            )
    db.commit()


def seed_diseases(db: Session) -> None:
    """播种疾病库。

    以 `docs/structured/disease-library/diseases.json` 为基线：
    已存在的病种**更新** payload 与元信息（否则改了题库却进不了系统），
    但保留数据库里的人工评审状态（approved 不被草稿覆盖）。
    """
    data = load_disease_file()
    for item in data.get("diseases", []):
        code = item.get("code")
        if not code:
            continue
        row = db.query(DiseaseProfile).filter(DiseaseProfile.code == code).first()
        if row is None:
            row = DiseaseProfile(
                code=code,
                name=item.get("name", code),
                aliases=item.get("aliases", []),
                system=item.get("system", ""),
                risk_level=item.get("risk_level", "observe"),
                review_status=data.get("review_status", "draft_pending_medical_review"),
                payload=item,
            )
            db.add(row)
            db.flush()
        else:
            # 更新基线内容，但人工评审状态优先保留
            row.name = item.get("name", row.name)
            row.aliases = item.get("aliases", row.aliases)
            row.system = item.get("system", row.system)
            row.risk_level = item.get("risk_level", row.risk_level)
            row.payload = item
            if row.review_status == "draft_pending_medical_review":
                row.review_status = data.get("review_status", row.review_status)

        # 症状权重与鉴别要点按基线重建
        db.query(DiseaseSymptom).filter(DiseaseSymptom.disease_code == code).delete()
        for symptom in item.get("symptoms", []) or []:
            db.add(
                DiseaseSymptom(
                    disease_code=code,
                    symptom_code=symptom.get("code", ""),
                    weight=symptom.get("weight", "secondary"),
                )
            )
        db.query(DiseaseDifferential).filter(DiseaseDifferential.disease_code == code).delete()
        for differential in item.get("differentials", []) or []:
            db.add(
                DiseaseDifferential(
                    disease_code=code,
                    vs_code=differential.get("vs_code", ""),
                    features=differential.get("features", []) or [],
                    points=float(differential.get("points", 0) or 0),
                    reason=differential.get("reason", ""),
                )
            )
    db.commit()


def seed_thresholds(db: Session) -> None:
    if db.query(AlertThreshold).count() > 0:
        return
    db.add(
        AlertThreshold(
            scope="global",
            threshold=60.0,
            level="urgent",
            review_status="draft_pending_medical_review",
            comment="全局默认阈值（草稿，待审批）",
            updated_by="系统初始化",
        )
    )
    for code, value, comment in [
        ("I21", 55.0, "急性心肌梗死阈值可更低，误报代价高"),
        ("I63", 50.0, "急性脑卒中阈值可更低"),
        ("A41", 50.0, "脓毒症阈值可更低"),
        ("E16", 45.0, "严重低血糖阈值可更低"),
    ]:
        db.add(
            AlertThreshold(
                scope="disease",
                disease_code=code,
                threshold=value,
                level="immediate",
                review_status="draft_pending_medical_review",
                comment=comment,
                updated_by="系统初始化",
            )
        )
    db.commit()


def seed_matching_rules(db: Session) -> None:
    if db.query(MatchingRule).count() > 0:
        return
    for key, value, description in [
        ("core_symptom_weight", 3.0, "核心症状权重（高于次要症状）"),
        ("secondary_symptom_weight", 1.0, "次要症状权重"),
        ("history_bonus", 15.0, "既往病史命中加分"),
        ("probability_temperature", 10.0, "参考概率归一化温度"),
        ("global_alert_threshold", 60.0, "全局提醒阈值"),
    ]:
        db.add(MatchingRule(key=key, value=value, description=description, updated_by="系统初始化"))
    db.commit()


def seed_report_templates(db: Session) -> None:
    """播种报告模板（来自 docs/structured/report-templates/*.json）。"""
    directory = REPO_ROOT / "docs" / "structured" / "report-templates"
    if not directory.exists():
        return
    for path in sorted(directory.glob("*.json")):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        code = payload.get("code")
        if not code:
            continue
        row = db.query(ReportTemplate).filter(ReportTemplate.code == code).first()
        if row is None:
            row = ReportTemplate(
                code=code,
                name=payload.get("name", code),
                version=payload.get("version", "0.1.0-draft"),
                scene=payload.get("scene", "professional"),
                review_status=payload.get("review_status", "draft_pending_medical_review"),
                payload=payload.get("template", payload),
                active=True,
            )
            db.add(row)
        else:
            row.name = payload.get("name", row.name)
            row.version = payload.get("version", row.version)
            row.scene = payload.get("scene", row.scene)
            row.payload = payload.get("template", row.payload)
    db.commit()


def seed_prompts(db: Session) -> None:
    if db.query(PromptTemplate).count() > 0:
        return
    for code, name, content in PROMPT_TEMPLATES:
        db.add(PromptTemplate(code=code, name=name, version="0.1.0-draft", content=content, active=True))
    db.commit()


def init_db(seed: bool = True) -> None:
    create_tables()
    if not seed:
        return
    db = SessionLocal()
    try:
        seed_patient(db)
        seed_users(db)
        seed_scales(db)
        seed_diseases(db)
        seed_thresholds(db)
        seed_matching_rules(db)
        seed_report_templates(db)
        seed_prompts(db)
    finally:
        db.close()


if __name__ == "__main__":
    init_db()
    print("数据库初始化完成。")
