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
}

export type InputType = "single" | "multi" | "number";

export interface ScaleQuestion {
  code: string;
  text: string;
  plain_text?: string;
  input_type: InputType;
  required?: boolean;
  options?: ScaleOption[];
  /** 实测项单位，如“秒”“米”“厘米” */
  unit?: string;
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

export interface AssessmentFinishResult {
  scores: ScaleScore[];
  branches?: { target_scale: string; reason?: string }[];
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
  weight?: number;
}

export interface MatchCandidate {
  disease_code: string;
  disease_name: string;
  /** 匹配度 0~100 */
  match_score: number;
  /** 参考概率 0~100 */
  ref_probability: number;
  hit_symptoms?: MatchSymptom[];
  missing_symptoms?: MatchSymptom[];
  excluded_reasons?: string[];
  risk_level?: string;
  advice?: string;
}

export interface MatchAlert {
  level: string;
  message: string;
  department?: string;
  disclaimer: string;
}

export interface MatchRunDetail {
  id: string;
  patient_id: string;
  created_at?: string;
  thresholds?: MatchThreshold[];
  candidates: MatchCandidate[];
  alert?: MatchAlert;
  disclaimer: string;
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

export interface QualityMetrics {
  scoring_consistency?: number;
  match_accuracy?: number;
  false_alert_rate?: number;
  alert_response_rate?: number;
  pending_reviews?: number;
  stats?: Record<string, unknown>;
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
