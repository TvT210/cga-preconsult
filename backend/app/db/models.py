"""业务数据模型：配置类、业务类、审计与质控类。

设计原则：
- 题库、阈值、提示词等规则性数据全部入库，支持版本化与留痕，不硬编码在业务代码中；
- 评估与匹配记录保存所用题库版本、规则版本、模型与提示词版本，满足「版本留痕」红线；
- 敏感字段（身份证号）在写入时以应用层加密（AES 不在标准库内，改用 HMAC 派生 + 异或不可取，
  这里采用「掩码存储 + 哈希索引」策略：只保留掩码与检索用哈希，明文不落库）。
"""

from __future__ import annotations

import datetime as dt

from sqlalchemy import (
    JSON,
    Boolean,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


class User(Base):
    """账号与角色。role: elder / staff / doctor / admin。"""

    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(256))
    full_name: Mapped[str] = mapped_column(String(64), default="")
    role: Mapped[str] = mapped_column(String(16), index=True)
    department: Mapped[str] = mapped_column(String(64), default="")
    patient_id: Mapped[int | None] = mapped_column(ForeignKey("patients.id"), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=_now)


class Patient(Base):
    """老人主索引。"""

    __tablename__ = "patients"

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(64), index=True)
    gender: Mapped[str] = mapped_column(String(8), default="")
    birth_date: Mapped[dt.date | None] = mapped_column(Date, nullable=True)
    phone: Mapped[str] = mapped_column(String(32), default="")
    id_card_masked: Mapped[str] = mapped_column(String(32), default="")
    address: Mapped[str] = mapped_column(String(255), default="")
    emergency_contact: Mapped[str] = mapped_column(String(255), default="")
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=_now)

    @property
    def age(self) -> int | None:
        if not self.birth_date:
            return None
        today = dt.date.today()
        return today.year - self.birth_date.year - ((today.month, today.day) < (self.birth_date.month, self.birth_date.day))


class Preconsult(Base):
    """预问诊内容（每患者一条，字段级增量保存）。"""

    __tablename__ = "preconsults"

    id: Mapped[int] = mapped_column(primary_key=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey("patients.id"), unique=True, index=True)
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    updated_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    updated_at: Mapped[dt.datetime] = mapped_column(DateTime, default=_now, onupdate=_now)


class Consent(Base):
    """知情同意记录与撤回。"""

    __tablename__ = "consents"

    id: Mapped[int] = mapped_column(primary_key=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey("patients.id"), index=True)
    agreed: Mapped[bool] = mapped_column(Boolean)
    scope: Mapped[str] = mapped_column(String(255), default="评估、报告生成与就医提醒")
    ai_involved: Mapped[bool] = mapped_column(Boolean, default=True)
    operator_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    withdrawn_at: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=_now)


class ScaleTemplate(Base):
    """量表模板（对应附录 B 各表），payload 保存完整题库 JSON。"""

    __tablename__ = "scale_templates"

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(16), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(128))
    dimension: Mapped[str] = mapped_column(String(32), index=True)
    method: Mapped[str] = mapped_column(String(32), default="")
    standard_ref: Mapped[str] = mapped_column(String(64), default="")
    version: Mapped[str] = mapped_column(String(32), default="0.1.0-draft")
    review_status: Mapped[str] = mapped_column(String(48), default="draft_pending_medical_review")
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=_now)
    updated_at: Mapped[dt.datetime] = mapped_column(DateTime, default=_now, onupdate=_now)


class ScaleVersion(Base):
    """量表版本留痕。"""

    __tablename__ = "scale_versions"

    id: Mapped[int] = mapped_column(primary_key=True)
    scale_code: Mapped[str] = mapped_column(String(16), index=True)
    version: Mapped[str] = mapped_column(String(32))
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    reviewer: Mapped[str] = mapped_column(String(64), default="")
    comment: Mapped[str] = mapped_column(Text, default="")
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=_now)


class AssessmentSession(Base):
    """一次量表评估任务（支持断点续填）。"""

    __tablename__ = "assessment_sessions"

    id: Mapped[int] = mapped_column(primary_key=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey("patients.id"), index=True)
    scale_code: Mapped[str] = mapped_column(String(16), index=True)
    scale_version: Mapped[str] = mapped_column(String(32), default="0.1.0-draft")
    status: Mapped[str] = mapped_column(String(24), default="in_progress", index=True)
    mode: Mapped[str] = mapped_column(String(16), default="patient")
    proxy_name: Mapped[str] = mapped_column(String(64), default="")
    proxy_relation: Mapped[str] = mapped_column(String(32), default="")
    progress: Mapped[int] = mapped_column(Integer, default=0)
    current_question: Mapped[str] = mapped_column(String(32), default="")
    rule_version: Mapped[str] = mapped_column(String(32), default="0.1.0-draft")
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    reviewer_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    review_comment: Mapped[str] = mapped_column(Text, default="")
    started_at: Mapped[dt.datetime] = mapped_column(DateTime, default=_now)
    finished_at: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)
    reviewed_at: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)
    # 分支跳转派发溯源：本任务由哪次评估的哪条分支触发（A-3）
    # 沿该字段回溯即得本次评估链，用于环形防护，避免互相推荐造成无限派发。
    dispatched_from_id: Mapped[int | None] = mapped_column(
        ForeignKey("assessment_sessions.id"), nullable=True, index=True
    )
    dispatch_branch_code: Mapped[str] = mapped_column(String(32), default="")
    # 派发原因：自动派发取自题库分支的 reason，人工派发取医护填写的理由。
    # 落库而非临时查题库，是为了复核页/患者档案能直接展示「为什么多这一份」。
    dispatch_reason: Mapped[str] = mapped_column(String(255), default="")


class AssessmentAnswer(Base):
    """逐题作答（含实测值与代答人）。"""

    __tablename__ = "assessment_answers"
    __table_args__ = (UniqueConstraint("session_id", "question_code", name="uq_answer_session_question"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("assessment_sessions.id"), index=True)
    question_code: Mapped[str] = mapped_column(String(32))
    value: Mapped[str] = mapped_column(String(255), default="")
    score: Mapped[float | None] = mapped_column(Float, nullable=True)
    measured: Mapped[float | None] = mapped_column(Float, nullable=True)
    skipped: Mapped[bool] = mapped_column(Boolean, default=False)
    skip_reason: Mapped[str] = mapped_column(String(255), default="")
    proxy_flag: Mapped[bool] = mapped_column(Boolean, default=False)
    answered_by: Mapped[str] = mapped_column(String(64), default="")
    answered_at: Mapped[dt.datetime] = mapped_column(DateTime, default=_now)


class AssessmentScore(Base):
    """计分与判读结果。"""

    __tablename__ = "assessment_scores"

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("assessment_sessions.id"), index=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey("patients.id"), index=True)
    scale_code: Mapped[str] = mapped_column(String(16), index=True)
    scale_version: Mapped[str] = mapped_column(String(32), default="")
    rule_version: Mapped[str] = mapped_column(String(32), default="")
    total: Mapped[float] = mapped_column(Float, default=0)
    level: Mapped[str] = mapped_column(String(64), default="")
    interpretation: Mapped[str] = mapped_column(Text, default="")
    abnormal: Mapped[bool] = mapped_column(Boolean, default=False)
    severity: Mapped[str] = mapped_column(String(16), default="none")
    flags: Mapped[list] = mapped_column(JSON, default=list)
    explanation: Mapped[str] = mapped_column(Text, default="")
    rule_refs: Mapped[list] = mapped_column(JSON, default=list)
    missing_items: Mapped[list] = mapped_column(JSON, default=list)
    needs_manual_review: Mapped[bool] = mapped_column(Boolean, default=False)
    reviewed: Mapped[bool] = mapped_column(Boolean, default=False)
    pre_review_total: Mapped[float | None] = mapped_column(Float, nullable=True)
    pre_review_level: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=_now)


class DiseaseProfile(Base):
    """老年易发疾病主表。"""

    __tablename__ = "disease_profiles"

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(16), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(64), index=True)
    aliases: Mapped[list] = mapped_column(JSON, default=list)
    system: Mapped[str] = mapped_column(String(32), default="")
    risk_level: Mapped[str] = mapped_column(String(16), default="observe")
    review_status: Mapped[str] = mapped_column(String(48), default="draft_pending_medical_review")
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=_now)


class DiseaseSymptom(Base):
    """疾病症状权重（核心/次要）。"""

    __tablename__ = "disease_symptoms"

    id: Mapped[int] = mapped_column(primary_key=True)
    disease_code: Mapped[str] = mapped_column(String(16), index=True)
    symptom_code: Mapped[str] = mapped_column(String(48), index=True)
    weight: Mapped[str] = mapped_column(String(16), default="secondary")


class DiseaseDifferential(Base):
    """鉴别要点：缺少 features 时对本病扣分。"""

    __tablename__ = "disease_differentials"

    id: Mapped[int] = mapped_column(primary_key=True)
    disease_code: Mapped[str] = mapped_column(String(16), index=True)
    vs_code: Mapped[str] = mapped_column(String(16))
    features: Mapped[list] = mapped_column(JSON, default=list)
    points: Mapped[float] = mapped_column(Float, default=0)
    reason: Mapped[str] = mapped_column(Text, default="")


class AlertThreshold(Base):
    """就医提醒阈值：全局 + 病种，可配置、可审计。"""

    __tablename__ = "alert_thresholds"

    id: Mapped[int] = mapped_column(primary_key=True)
    scope: Mapped[str] = mapped_column(String(16), default="global", index=True)
    disease_code: Mapped[str] = mapped_column(String(16), default="")
    threshold: Mapped[float] = mapped_column(Float, default=60)
    level: Mapped[str] = mapped_column(String(16), default="urgent")
    review_status: Mapped[str] = mapped_column(String(48), default="draft_pending_medical_review")
    updated_by: Mapped[str] = mapped_column(String(64), default="")
    comment: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=_now)
    updated_at: Mapped[dt.datetime] = mapped_column(DateTime, default=_now, onupdate=_now)


class MatchingRule(Base):
    """匹配权重配置。"""

    __tablename__ = "matching_rules"

    id: Mapped[int] = mapped_column(primary_key=True)
    key: Mapped[str] = mapped_column(String(48), unique=True)
    value: Mapped[float] = mapped_column(Float, default=0)
    description: Mapped[str] = mapped_column(String(255), default="")
    updated_by: Mapped[str] = mapped_column(String(64), default="")
    updated_at: Mapped[dt.datetime] = mapped_column(DateTime, default=_now, onupdate=_now)


class MatchRun(Base):
    """匹配批次（含输入快照与阈值快照，供复盘）。"""

    __tablename__ = "match_runs"

    id: Mapped[int] = mapped_column(primary_key=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey("patients.id"), index=True)
    input_snapshot: Mapped[dict] = mapped_column(JSON, default=dict)
    thresholds: Mapped[dict] = mapped_column(JSON, default=dict)
    rule_version: Mapped[str] = mapped_column(String(32), default="0.1.0-draft")
    model_version: Mapped[str] = mapped_column(String(64), default="")
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=_now)


class MatchCandidate(Base):
    """候选疾病：匹配度 + 参考概率 + 依据。"""

    __tablename__ = "match_candidates"

    id: Mapped[int] = mapped_column(primary_key=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("match_runs.id"), index=True)
    disease_code: Mapped[str] = mapped_column(String(16), index=True)
    disease_name: Mapped[str] = mapped_column(String(64), default="")
    rank: Mapped[int] = mapped_column(Integer, default=0)
    match_score: Mapped[float] = mapped_column(Float, default=0)
    ref_probability: Mapped[float] = mapped_column(Float, default=0)
    raw_score: Mapped[float] = mapped_column(Float, default=0)
    hit_symptoms: Mapped[list] = mapped_column(JSON, default=list)
    missing_symptoms: Mapped[list] = mapped_column(JSON, default=list)
    excluded_reasons: Mapped[list] = mapped_column(JSON, default=list)
    red_flags: Mapped[list] = mapped_column(JSON, default=list)
    protective_signs: Mapped[list] = mapped_column(JSON, default=list)
    risk_factor_hits: Mapped[list] = mapped_column(JSON, default=list)
    pattern_hits: Mapped[list] = mapped_column(JSON, default=list)
    distinctive_symptoms: Mapped[list] = mapped_column(JSON, default=list)
    shared_symptoms: Mapped[list] = mapped_column(JSON, default=list)
    risk_level: Mapped[str] = mapped_column(String(16), default="observe")
    advice: Mapped[dict] = mapped_column(JSON, default=dict)
    evidence_insufficient: Mapped[bool] = mapped_column(Boolean, default=False)


class MatchAiReview(Base):
    """AI 复核记录：语义消歧、排序建议、追问建议与通俗解释。

    AI 不改分值、不改阈值、不改提醒等级——这里保存的是**建议**，最终由医护裁决。
    """

    __tablename__ = "match_ai_reviews"

    id: Mapped[int] = mapped_column(primary_key=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("match_runs.id"), index=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey("patients.id"), index=True)
    model: Mapped[str] = mapped_column(String(64), default="")
    prompt_version: Mapped[str] = mapped_column(String(32), default="")
    input_snapshot: Mapped[dict] = mapped_column(JSON, default=dict)
    output: Mapped[dict] = mapped_column(JSON, default=dict)
    latency_ms: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=_now)


class Alert(Base):
    """就医提醒。"""

    __tablename__ = "alerts"

    id: Mapped[int] = mapped_column(primary_key=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey("patients.id"), index=True)
    match_run_id: Mapped[int | None] = mapped_column(ForeignKey("match_runs.id"), nullable=True)
    level: Mapped[str] = mapped_column(String(16), index=True)
    message: Mapped[str] = mapped_column(Text, default="")
    department: Mapped[str] = mapped_column(String(64), default="")
    disclaimer: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(16), default="pending", index=True)
    is_false_positive: Mapped[bool] = mapped_column(Boolean, default=False)
    handled_by: Mapped[str] = mapped_column(String(64), default="")
    handled_at: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)
    handle_comment: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=_now)


class CgaReport(Base):
    """老年综合评估报告（含版本锁定）。"""

    __tablename__ = "cga_reports"

    id: Mapped[int] = mapped_column(primary_key=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey("patients.id"), index=True)
    version: Mapped[int] = mapped_column(Integer, default=1)
    title: Mapped[str] = mapped_column(String(128), default="老年综合评估报告")
    template_code: Mapped[str] = mapped_column(String(32), default="professional")
    sections: Mapped[dict] = mapped_column(JSON, default=dict)
    disclaimer: Mapped[str] = mapped_column(Text, default="")
    locked: Mapped[bool] = mapped_column(Boolean, default=False)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=_now)


class ReportTemplate(Base):
    """综合评估报告模板（专业版 / 通俗版 / 存档版）。"""

    __tablename__ = "report_templates"

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(64), default="")
    version: Mapped[str] = mapped_column(String(32), default="0.1.0-draft")
    scene: Mapped[str] = mapped_column(String(32), default="professional")
    review_status: Mapped[str] = mapped_column(String(48), default="draft_pending_medical_review")
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=_now)


class Followup(Base):
    """随访计划与执行记录。"""

    __tablename__ = "followups"

    id: Mapped[int] = mapped_column(primary_key=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey("patients.id"), index=True)
    interval_days: Mapped[int] = mapped_column(Integer, default=30)
    focus_items: Mapped[list] = mapped_column(JSON, default=list)
    due_at: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="planned", index=True)
    note: Mapped[str] = mapped_column(Text, default="")
    result: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=_now)
    completed_at: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)


class DialogueSession(Base):
    """大模型对话会话。"""

    __tablename__ = "ai_dialogue_sessions"

    id: Mapped[int] = mapped_column(primary_key=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey("patients.id"), index=True)
    title: Mapped[str] = mapped_column(String(128), default="就医前对话")
    model: Mapped[str] = mapped_column(String(64), default="")
    prompt_version: Mapped[str] = mapped_column(String(32), default="0.1.0-draft")
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=_now)


class DialogueTurn(Base):
    """对话逐轮记录。"""

    __tablename__ = "ai_dialogue_turns"

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("ai_dialogue_sessions.id"), index=True)
    role: Mapped[str] = mapped_column(String(16))
    content: Mapped[str] = mapped_column(Text, default="")
    extracted: Mapped[dict] = mapped_column(JSON, default=dict)
    safety_note: Mapped[str] = mapped_column(Text, default="")
    conflict_flags: Mapped[list] = mapped_column(JSON, default=list)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=_now)


class PatientMedicalProfile(Base):
    """老人专属医疗数据库（结构化画像）。"""

    __tablename__ = "patient_medical_profiles"

    id: Mapped[int] = mapped_column(primary_key=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey("patients.id"), unique=True, index=True)
    symptoms: Mapped[list] = mapped_column(JSON, default=list)
    conditions: Mapped[list] = mapped_column(JSON, default=list)
    medications: Mapped[list] = mapped_column(JSON, default=list)
    lifestyle: Mapped[dict] = mapped_column(JSON, default=dict)
    chief_complaint: Mapped[dict] = mapped_column(JSON, default=dict)
    source: Mapped[str] = mapped_column(String(32), default="dialogue")
    updated_at: Mapped[dt.datetime] = mapped_column(DateTime, default=_now, onupdate=_now)


class PeriodicAssessment(Base):
    """定期自动评估（AI 补充评估）。"""

    __tablename__ = "periodic_assessments"

    id: Mapped[int] = mapped_column(primary_key=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey("patients.id"), index=True)
    dimension_conclusions: Mapped[list] = mapped_column(JSON, default=list)
    trend: Mapped[list] = mapped_column(JSON, default=list)
    model: Mapped[str] = mapped_column(String(64), default="")
    prompt_version: Mapped[str] = mapped_column(String(32), default="")
    input_snapshot: Mapped[dict] = mapped_column(JSON, default=dict)
    notice: Mapped[str] = mapped_column(Text, default="")
    generated_at: Mapped[dt.datetime] = mapped_column(DateTime, default=_now)


class PromptTemplate(Base):
    """提示词模板与版本。"""

    __tablename__ = "prompt_templates"

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(48), index=True)
    name: Mapped[str] = mapped_column(String(64), default="")
    version: Mapped[str] = mapped_column(String(32), default="0.1.0-draft")
    content: Mapped[str] = mapped_column(Text, default="")
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=_now)


class AuditLog(Base):
    """审计日志：查看、修改、导出、阈值变更、发布。"""

    __tablename__ = "audit_logs"

    id: Mapped[int] = mapped_column(primary_key=True)
    actor_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    actor_name: Mapped[str] = mapped_column(String(64), default="")
    action: Mapped[str] = mapped_column(String(48), index=True)
    target_type: Mapped[str] = mapped_column(String(32), default="")
    target_id: Mapped[str] = mapped_column(String(48), default="")
    detail: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=_now, index=True)


class TemplateApproval(Base):
    """题库、疾病库、阈值、文案审批。"""

    __tablename__ = "template_approvals"

    id: Mapped[int] = mapped_column(primary_key=True)
    target_type: Mapped[str] = mapped_column(String(32), index=True)
    target_id: Mapped[str] = mapped_column(String(48), index=True)
    action: Mapped[str] = mapped_column(String(24))
    reviewer: Mapped[str] = mapped_column(String(64), default="")
    comment: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=_now)


class ModelRun(Base):
    """模型调用记录（模型/版本/提示词/耗时/快照）。"""

    __tablename__ = "model_runs"

    id: Mapped[int] = mapped_column(primary_key=True)
    task: Mapped[str] = mapped_column(String(48), index=True)
    model: Mapped[str] = mapped_column(String(64), default="")
    prompt_version: Mapped[str] = mapped_column(String(32), default="")
    latency_ms: Mapped[int] = mapped_column(Integer, default=0)
    input_snapshot: Mapped[dict] = mapped_column(JSON, default=dict)
    output_snapshot: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=_now)
