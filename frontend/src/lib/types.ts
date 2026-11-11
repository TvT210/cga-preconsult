/**
 * 全站数据类型定义，与 docs/api-contract.md 契约一一对应。
 * 所有命名保持英文字段名（后端返回原样），界面文案一律简体中文。
 */

/* ------------------------------------------------------------------ */
/* 通用                                                                */
/* ------------------------------------------------------------------ */

/** 角色：elder 老人/家属、staff 评估人员/护士、doctor 医生、admin 管理员 */
export type Role = "elder" | "staff" | "doctor" | "admin";

/** 后端统一响应包装 */
export interface ApiEnvelope<T> {
  code: number;
  message: string;
  data: T;
}

/** 列表统一返回结构 */
export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}

/* ------------------------------------------------------------------ */
/* 认证                                                                */
/* ------------------------------------------------------------------ */

export interface User {
  id: string | number;
  username: string;
  role: Role;
  full_name: string;
  /** 老人角色绑定的患者标识（后端为整数主键） */
  patient_id?: string | number | null;
  department?: string;
}

export interface LoginResult {
  token: string;
  user: User;
}

/* ------------------------------------------------------------------ */
/* 患者与预问诊                                                        */
/* ------------------------------------------------------------------ */

export interface Patient {
  /** 后端整数主键，路由与接口均使用该值 */
  id: string | number;
  /** 业务编号，如 P0001 */
  code?: string;
  name: string;
  gender: string;
  birth_date?: string;
  age?: number;
  phone?: string;
  /** 身份证号已脱敏 */
  id_card_masked?: string;
  address?: string;
  emergency_contact?: string;
  created_at?: string;
  updated_at?: string;
}

export interface PatientCreateBody {
  name: string;
  gender: string;
  birth_date: string;
  phone?: string;
  id_card?: string;
  address?: string;
  emergency_contact?: string;
}

export interface PreconsultBasic {
  gender?: string;
  birth_date?: string;
  marital_status?: string;
  education?: string;
  living_status?: string;
  medical_insurance?: string;
  contact_name?: string;
  contact_phone?: string;
}

export interface ChiefComplaint {
  text?: string;
  onset?: string;
  site?: string;
  nature?: string;
  severity?: number;
  course?: string;
  associated?: string[];
}

export interface MedicationItem {
  name: string;
  dose?: string;
  since?: string;
}

export interface AllergyItem {
  name: string;
  reaction?: string;
}

export interface MedicalHistory {
  conditions?: string[];
  medications?: MedicationItem[];
  allergies?: AllergyItem[];
}

export interface FallRecord {
  time?: string;
  place?: string;
  cause?: string;
  injury?: string;
}

export interface Lifestyle {
  smoking?: boolean;
  drinking?: boolean;
  diet?: string;
  activity?: string;
  sleep?: string;
  falls?: FallRecord[];
}

export interface ProxyInfo {
  is_proxy?: boolean;
  proxy_name?: string;
  proxy_relation?: string;
}

export interface Preconsult {
  basic?: PreconsultBasic;
  chief_complaint?: ChiefComplaint;
  history?: MedicalHistory;
  lifestyle?: Lifestyle;
  proxy?: ProxyInfo;
}

export interface ConsentRecord {
  id?: string;
  patient_id?: string;
  agreed: boolean;
  scope?: string;
  withdraw?: boolean;
  created_at?: string;
}

export interface TimelineEvent {
  id?: string;
  type?: string;
  category?: string;
  title?: string;
  description?: string;
  created_at?: string;
  operator?: string;
}

/* ------------------------------------------------------------------ */
/* 量表中心                                                            */
/* ------------------------------------------------------------------ */

export type ReviewStatus =
  | "draft_pending_medical_review"
  | "approved"
  | "deprecated"
  | string;

export interface ScaleOption {
  value: string;
  label: string;
  score?: number;
  /** 实测分档区间下界（含）；与 `max` 同为 undefined 者为兜底选项，如「不能完成」 */
  min?: number;
  /** 实测分档区间上界（含） */
  max?: number;
  /** 分级型量表的选项自带结论（如洼田 1 级/2 级），由后端 `single_option_level` 使用 */
  level?: string;
  abnormal?: boolean;
  severity?: string;
}

export type InputType = "single" | "multi" | "number";

export interface ScaleQuestion {
  code: string;
  text: string;
  plain_text?: string;
  input_type: InputType;
  required?: boolean;
  options?: ScaleOption[];
  /** 实测项单位，如“秒”“米”“厘米”（题库 `measure.unit` 的展开结果） */
  unit?: string;
  /** 实测项施测提示（题库 `measure.hint` 的展开结果） */
  unit_hint?: string;
  /** 题库原始字段，服务端保留未删 */
  measure?: { unit?: string; hint?: string };
  /**
   * 实测分档题：可填数值，由服务端按 `options[].min/max` 自动落档。
   * 为 true 时前端渲染「数值输入 + 计时器」，而不是手动点档位。
   */
  banded_input?: boolean;
  /** 无区间的兜底选项 value（「不能完成」「不尝试」等），与数值输入互斥 */
  fallback_options?: string[];
  /** 仅记录、不参与计分的题目 */
  record_only?: boolean;
  /** 条目级生效条件（如 B.15 仅在插管时启用第 3 项） */
  when?: Record<string, unknown>;
  min?: number;
  max?: number;
}

export interface ScaleSection {
  code: string;
  title: string;
  questions: ScaleQuestion[];
}

export interface ScaleListItem {
  code: string;
  name: string;
  dimension: string;
  method: string;
  review_status: ReviewStatus;
  item_count: number;
  version: string;
  notes?: string;
}

export interface ScaleLevel {
  min: number;
  max: number;
  level: string;
  interpretation?: string;
  abnormal?: boolean;
  severity?: string;
}

export interface ScaleScoring {
  score?: {
    rule_type?: string;
    config?: {
      items?: { code: string; label: string; max_score: number }[];
    };
    explanation?: string;
  };
  levels?: {
    rule_type?: string;
    config?: { levels?: ScaleLevel[] };
  };
  flags?: unknown[];
  [key: string]: unknown;
}

export interface ScaleDetail extends ScaleListItem {
  standard_ref?: string;
  summary?: string;
  collection?: {
    support?: string[];
    proxy_allowed?: boolean;
    measured?: boolean;
  };
  sections: ScaleSection[];
  scoring?: ScaleScoring;
  branches?: { code?: string; target_scale?: string; reason?: string }[];
  notes?: string;
  /** 题库是否具备可判读条件 */
  ready_for_scoring?: boolean;
}

export interface ScaleVersion {
  id?: string | number;
  scale_code?: string;
  version: string;
  created_at?: string;
  reviewer?: string;
  comment?: string;
  author?: string;
  note?: string;
  review_status?: ReviewStatus;
}

/* ------------------------------------------------------------------ */
/* 评估会话                                                            */
/* ------------------------------------------------------------------ */

export type AssessmentStatus =
  | "in_progress"
  | "finished"
  | "reviewed"
  | "abandoned"
  | string;

export type AnswerValue = string | string[] | number | null;

export interface AssessmentAnswer {
  question_code: string;
  value: AnswerValue;
  /** 后端判定的本题得分 */
  score?: number;
  measured?: number;
  proxy_flag?: boolean;
  answered_by?: string;
  skipped?: boolean;
  skip_reason?: string;
}

export interface AssessmentSession {
  id: string | number;
  patient_id: string | number;
  scale_code: string;
  scale_name?: string;
  dimension?: string;
  status: AssessmentStatus;
  /** 已作答题数（后端返回数字）；也可为 {answered,total,percent} */
  progress?: number | { answered?: number; total?: number; percent?: number };
  /** 题目总数 */
  total_questions?: number;
  current_question?: ScaleQuestion | string | null;
  questions?: ScaleQuestion[];
  answers?: AssessmentAnswer[];
  mode?: "patient" | "staff" | string;
  proxy?: ProxyInfo;
  scale_version?: string;
  rule_version?: string;
  started_at?: string;
  finished_at?: string;
  created_at?: string;
  updated_at?: string;
}

export interface AssessmentListItem {
  id: string | number;
  patient_id: string | number;
  scale_code: string;
  scale_name?: string;
  status: AssessmentStatus;
  progress?: number | { answered?: number; total?: number; percent?: number };
  total_questions?: number;
  mode?: string;
  started_at?: string;
  finished_at?: string;
  created_at?: string;
  updated_at?: string;
  /** 判读结果（/patients/{id}/assessments 会带回 score） */
  score?: {
    total?: number;
    level?: string;
    interpretation?: string;
    abnormal?: boolean;
    severity?: string;
    needs_manual_review?: boolean;
  } | null;
}

export interface ScaleScore {
  scale_code: string;
  total: number;
  level: string;
  interpretation?: string;
  abnormal?: boolean;
  severity?: string;
  flags?: string[];
  explanation?: string;
  /** 结论回溯到的规则条目 */
  rule_refs?: string[];
}

/** 分支跳转派发结果：筛查阳性后系统为患者派生的待办任务 */
export interface DispatchedBranch {
  branch_code: string;
  source_scale: string;
  target_scale: string;
  /** 目标量表中文名，用于结果页展示 */
  target_name?: string;
  reason?: string;
  /** dispatched 本次新建；reused 复用已有进行中任务；skipped 未派发 */
  status: "dispatched" | "reused" | "skipped";
  /** skipped 时说明原因：cycle 链上已做过 / duplicate 同批重复 / no_questions 条目未补录 / scale_missing 题库无此量表 */
  skip_reason?: "" | "cycle" | "duplicate" | "no_questions" | "scale_missing";
  session_id?: number | null;
  session_status?: string;
}

export interface AssessmentFinishResult {
  scores: ScaleScore[];
  branches?: { branch_code?: string; target_scale: string; reason?: string }[];
  dispatched?: DispatchedBranch[];
  needs_manual_review?: boolean;
}

/** 复核时的单题修正 */
export interface Correction {
  question_code: string;
  value: AnswerValue;
}

export interface AssessmentReviewBody {
  action: "approve" | "correct";
  corrections: Correction[];
  comment: string;
}

/* ------------------------------------------------------------------ */
/* 报告                                                                */
/* ------------------------------------------------------------------ */

export interface ReportListItem {
  id: string | number;
  patient_id: string | number;
  version?: number;
  locked?: boolean;
  title?: string;
  /** 使用的报告模板编码（导出文件名会带上模板名） */
  template_code?: string;
  created_at?: string;
}

export interface ReportSections {
  basic?: Record<string, unknown>;
  scale_results?: ScaleScore[] | Record<string, unknown>[];
  dimension_summary?: { dimension?: string; conclusion?: string }[] | Record<string, unknown>[];
  positive_list?: { item?: string; level?: string; need_special?: boolean }[] | Record<string, unknown>[];
  ai_supplement?: Record<string, unknown>;
  disease_match?: MatchRunDetail;
  interventions?: string[] | Record<string, unknown>[];
  mdt_opinions?: string[] | Record<string, unknown>[];
  followup_plan?: Record<string, unknown>;
}

export interface ReportDetail {
  id: string | number;
  patient_id: string | number;
  version?: number;
  locked?: boolean;
  title?: string;
  template_code?: string;
  created_at?: string;
  sections: ReportSections;
  disclaimer?: string;
}

/* ------------------------------------------------------------------ */
/* 疾病库与匹配                                                        */
/* ------------------------------------------------------------------ */

export interface DiseaseSummary {
  code: string;
  name: string;
  system?: string;
  risk_level?: string;
  symptom_count?: number;
  review_status?: ReviewStatus;
}

export interface DiseaseListResponse {
  diseases: DiseaseSummary[];
  thresholds?: MatchThreshold[];
}

export interface MatchSymptom {
  code: string;
  term: string;
  /** 命中权重：core / secondary / history（后端也可能是数字权重） */
  weight?: number | string;
  /** 该症状贡献的得分 */
  points?: number;
  /** 区分度系数 0.5~2.0，越大说明该症状说明力越强 */
  distinctive?: number;
  /** 该症状同时命中的其它候选病种编码 */
  shared_with?: string[];
  note?: string;
}

/** 症状组合命中（医生初诊看的是组合） */
export interface MatchPatternHit {
  code?: string;
  term?: string;
  weight?: string;
  points?: number;
  /** 组合内命中的症状编码 */
  symptoms?: string[];
}

/** 命中依据条目（区分性症状 / 共享症状 / 红旗征 / 保护性征象） */
export interface MatchEvidenceItem {
  code?: string;
  term?: string;
  weight?: string;
  distinctive?: number;
  shared_with?: string[];
  note?: string;
}

/** 鉴别排除理由（points 为负值，表示扣分） */
export interface MatchExclusion {
  vs_code?: string;
  reason?: string;
  points?: number;
}

/** 就医建议 */
export interface MatchAdvice {
  department?: string;
  urgency?: string;
  text?: string;
}

export interface MatchCandidate {
  /** 规则引擎给出的排序（1 起） */
  rank?: number;
  disease_code: string;
  disease_name: string;
  /** 匹配度 0~100 */
  match_score: number;
  /** 参考概率 0~100（候选间相对可能性，非患病概率） */
  ref_probability: number;
  hit_symptoms?: MatchSymptom[];
  missing_symptoms?: MatchSymptom[];
  /** 只命中本候选的症状 = 支持本病的关键线索 */
  distinctive_symptoms?: MatchEvidenceItem[];
  /** 多个候选共有的症状 = 区分度低 */
  shared_symptoms?: MatchEvidenceItem[];
  /** 症状组合命中 */
  pattern_hits?: MatchPatternHit[];
  /** 命中的急症红旗征 */
  red_flags?: MatchEvidenceItem[];
  /** 命中的保护性征象（已扣分） */
  protective_signs?: MatchEvidenceItem[];
  /** 该老人已具备的高危因素 */
  risk_factor_hits?: { factor?: string; detail?: string }[];
  /** 该病的完整高危因素清单（仅供医护阅读，不参与打分） */
  risk_factors?: { factor?: string; detail?: string }[];
  excluded_reasons?: (MatchExclusion | string)[];
  risk_level?: string;
  advice?: MatchAdvice | string;
  /** true 表示证据不足、补位展示，前端应弱化 */
  evidence_insufficient?: boolean;
}

export interface MatchAlert {
  id?: string | number;
  level: string;
  message: string;
  department?: string;
  status?: string;
  red_flags?: MatchEvidenceItem[];
  disclaimer: string;
}

export interface MatchRunDetail {
  id: string;
  patient_id: string;
  created_at?: string;
  rule_version?: string;
  thresholds?: Record<string, number> | MatchThreshold[];
  candidates: MatchCandidate[];
  alert?: MatchAlert;
  disclaimer: string;
  /** POST /matching/run 携带 with_ai_review 时附带 */
  ai_review?: AiReview;
}

/* ------------------------------------------------------------------ */
/* AI 语义复核（契约 §7）                                              */
/* ------------------------------------------------------------------ */

/** AI 建议排序中的单项 */
export interface AiRerankItem {
  disease_code: string;
  disease_name?: string;
  /** AI 建议的排序（1 起），与规则排序并列展示，由医护裁决 */
  ai_rank?: number;
  rationale?: string;
  /** high / medium / low */
  confidence?: string;
}

/** AI 建议的追问 */
export interface AiFollowUp {
  question?: string;
  reason?: string;
  /** high / medium / low */
  priority?: string;
}

/** 规则排序与 AI 判断的分歧 */
export interface AiDisagreement {
  disease_code?: string;
  rule_view?: string;
  ai_view?: string;
  note?: string;
}

/**
 * AI 语义复核结果。
 * 红线：AI 只给建议，不修改匹配度 / 参考概率 / 阈值 / 提醒等级。
 */
export interface AiReview {
  rerank?: AiRerankItem[];
  follow_ups?: AiFollowUp[];
  /** 按病种编码给出通俗解释 */
  explanations?: Record<string, string>;
  disagreements?: AiDisagreement[];
  model?: string;
  prompt_version?: string;
  latency_ms?: number;
  notice?: string;
  id?: string | number;
  run_id?: string | number;
  patient_id?: string | number;
  created_at?: string;
}

export interface MatchRunListItem {
  id: string;
  patient_id: string;
  created_at?: string;
}

export interface MatchThreshold {
  id?: string | number;
  scope?: string;
  disease_code?: string;
  disease_name?: string;
  threshold: number;
  level?: string;
  review_status?: ReviewStatus;
  updated_by?: string;
  updated_at?: string;
  comment?: string;
}

/* ------------------------------------------------------------------ */
/* AI 对话                                                             */
/* ------------------------------------------------------------------ */

export interface DialogueTurn {
  role: "user" | "assistant" | string;
  content: string;
  extracted?: DialogueExtracted;
  safety_note?: string;
  created_at?: string;
}

export interface DialogueExtracted {
  symptoms?: { code: string; term: string; source?: string; confidence?: number }[];
  conditions?: string[];
  medications?: string[];
  lifestyle?: Record<string, unknown>;
  chief_complaint?: Record<string, unknown>;
}

export interface DialogueConflict {
  field: string;
  dialogue_value?: unknown;
  scale_value?: unknown;
  note?: string;
}

export interface DialogueSession {
  id: string;
  patient_id: string;
  turns?: DialogueTurn[];
  profile?: Record<string, unknown>;
}

export interface DialogueReply {
  reply: string;
  extracted?: DialogueExtracted;
  safety_note?: string;
  conflict_flags?: DialogueConflict[];
  disclaimer?: string;
}

/* ------------------------------------------------------------------ */
/* 随访、提醒与定期评估                                                */
/* ------------------------------------------------------------------ */

export type AlertLevel = "immediate" | "urgent" | "elective" | "observe" | string;

export interface AlertItem {
  id: string;
  patient_id: string;
  level: AlertLevel;
  message: string;
  department?: string;
  status?: string;
  created_at?: string;
  handled_by?: string;
  handled_at?: string;
  handle_comment?: string;
  disclaimer?: string;
  /** 是否已被标记为误报（仅 POST /alerts/{id}/handle 的响应会带回） */
  is_false_positive?: boolean;
}

export interface FollowUpPlan {
  id: string;
  patient_id: string;
  interval_days?: number;
  focus_items?: string[];
  due_at?: string;
  note?: string;
  status?: string;
}

export interface PeriodicResult {
  id: string;
  patient_id: string;
  dimension_conclusions?: { dimension?: string; conclusion?: string }[];
  trend?: unknown[];
  model?: string;
  prompt_version?: string;
  generated_at?: string;
  notice?: string;
}

/* ------------------------------------------------------------------ */
/* 知识库图谱（医护端可视化）                                          */
/* ------------------------------------------------------------------ */

/** 节点类型：疾病 / 症状 / 量表 */
export type KnowledgeNodeType = "disease" | "symptom" | "scale";

/** 边类型：core 核心症状 / secondary 次要症状 / focus 关注项 / synonym 同义 */
export type KnowledgeEdgeKind = "core" | "secondary" | "focus" | "synonym";

/** 图谱节点 */
export interface KnowledgeNode {
  /** 形如 `disease:I21` / `symptom:xxx` / `scale:B.1` */
  id: string;
  type: KnowledgeNodeType;
  /** 中文名 */
  label: string;
  /** 分组：疾病的系统 / 症状的分类 / 量表的维度 */
  group: string;
  /** 风险等级（仅疾病节点） */
  risk?: string;
  /** 附加信息：别名、鉴别问法、题目数等 */
  meta?: {
    aliases?: string[];
    review_status?: string;
    atypical?: string[];
    advice?: string;
    synonyms?: string[];
    probe?: string;
    method?: string;
    item_count?: number;
    [key: string]: unknown;
  };
}

/** 图谱边 */
export interface KnowledgeEdge {
  source: string;
  target: string;
  kind: KnowledgeEdgeKind;
  /** 边上的说明文案 */
  label?: string;
  /** 关注项对应的题号 */
  item?: string;
  /** 关注项对应的题目文本 */
  item_text?: string;
}

/** 图谱统计 */
export interface KnowledgeGraphStats {
  nodes?: number;
  edges?: number;
  by_type?: Record<string, number>;
  edge_kinds?: Record<string, number>;
}

/** 知识库图谱响应 */
export interface KnowledgeGraph {
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  stats?: KnowledgeGraphStats;
  /** 免责提示：内容来自待医学评审的草稿，仅供医护参考，不构成诊断 */
  notice?: string;
}

/** 症状关联的病种条目 */
export interface SymptomRelatedDisease {
  code?: string;
  name?: string;
  /** core 优先排序 */
  weight?: string;
  risk_level?: string;
  system?: string;
  advice?: string;
  atypical?: string[];
}

/** 症状可加测的量表 */
export interface SymptomRelatedScale {
  scale?: string;
  note?: string;
  item?: string;
}

/** 单个症状详情 */
export interface SymptomDetail {
  code: string;
  term: string;
  category?: string;
  synonyms?: string[];
  /** 鉴别问法 */
  probe?: string;
  related_diseases?: SymptomRelatedDisease[];
  related_scales?: SymptomRelatedScale[];
  disease_count?: number;
  notice?: string;
}

/** 知识库概览统计 */
export interface KnowledgeOverview {
  diseases?: number;
  symptoms?: number;
  scales?: number;
  scales_with_items?: number;
  core_symptom_links?: number;
  symptoms_with_probe?: number;
  review_status?: string;
}

/* ------------------------------------------------------------------ */
/* 管理与质控                                                          */
/* ------------------------------------------------------------------ */

export interface AdminUser {
  id: string | number;
  username: string;
  full_name?: string;
  role?: Role;
  department?: string;
  patient_id?: string | number | null;
  active?: boolean;
  created_at?: string;
}

/** 单个量表的评估统计 */
export interface ScaleStatBucket {
  total?: number;
  abnormal?: number;
  pending?: number;
}

/**
 * 质控指标（契约 §10）。
 * 注意：`match_accuracy` / `match_recall` 需要人工标注集，暂无数据时为 `null`，
 * 前端必须渲染成「暂无数据（需标注集）」，**不得**当作 0。
 */
export interface QualityMetrics {
  /* 评估过程 */
  assessment_completion_rate?: number | null;
  review_rate?: number | null;
  abnormal_detection_rate?: number | null;
  pending_confirmation_rate?: number | null;
  /** 计分一致率（由「复核是否改分」喂养） */
  scoring_consistency?: number | null;
  scoring_consistency_samples?: number;
  /* 提醒闭环 */
  alert_response_rate?: number | null;
  alert_escalation_rate?: number | null;
  high_level_alert_ratio?: number | null;
  /** 误报率（由「标记误报」喂养） */
  false_alert_rate?: number | null;
  false_alert_samples?: number;
  /* 匹配效果 */
  match_accuracy?: number | null;
  match_recall?: number | null;
  top1_match_score_avg?: number | null;
  /** Top1 与 Top2 匹配度平均差值，越小说明越难区分（难例信号） */
  top1_top2_gap_avg?: number | null;
  ai_review_coverage?: number | null;
  disease_library_coverage?: number | null;
  disease_library_size?: number;
  disease_hit_count?: number;
  /* 分布 */
  scale_stats?: Record<string, ScaleStatBucket>;
  stats?: Record<string, unknown>;
  note?: string;
  generated_at?: string;
}

/** 报告模板（契约 §6） */
export interface ReportTemplate {
  code: string;
  name: string;
  version?: string;
  /** professional / plain */
  scene?: string;
  review_status?: ReviewStatus;
  active?: boolean;
  created_at?: string;
}

/** 看板汇总（与后端 /admin/stats/overview 字段一致） */
export interface StatsOverview {
  patients?: number;
  users?: number;
  assessments?: number;
  abnormal_assessments?: number;
  reports?: number;
  match_runs?: number;
  alerts?: number;
  pending_review?: number;
  generated_at?: string;
  [key: string]: unknown;
}

export interface AuditLog {
  id?: string;
  actor?: string;
  target?: string;
  action?: string;
  created_at?: string;
  summary?: string;
}
