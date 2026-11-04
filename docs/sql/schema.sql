-- 老年人就医预问诊与老年综合评估系统 · PostgreSQL 表结构
-- 由 backend/app/db/models.py 自动导出（勿手工修改，模型变更后重新生成）
-- 生成命令：python tools/export_schema.py

BEGIN;

CREATE TABLE users (
	id SERIAL NOT NULL, 
	username VARCHAR(64) NOT NULL, 
	password_hash VARCHAR(256) NOT NULL, 
	full_name VARCHAR(64) NOT NULL, 
	role VARCHAR(16) NOT NULL, 
	department VARCHAR(64) NOT NULL, 
	patient_id INTEGER, 
	is_active BOOLEAN NOT NULL, 
	created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(patient_id) REFERENCES patients (id)
);

CREATE TABLE patients (
	id SERIAL NOT NULL, 
	code VARCHAR(32) NOT NULL, 
	name VARCHAR(64) NOT NULL, 
	gender VARCHAR(8) NOT NULL, 
	birth_date DATE, 
	phone VARCHAR(32) NOT NULL, 
	id_card_masked VARCHAR(32) NOT NULL, 
	address VARCHAR(255) NOT NULL, 
	emergency_contact VARCHAR(255) NOT NULL, 
	created_by INTEGER, 
	created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(created_by) REFERENCES users (id)
);

CREATE TABLE preconsults (
	id SERIAL NOT NULL, 
	patient_id INTEGER NOT NULL, 
	payload JSON NOT NULL, 
	updated_by INTEGER, 
	updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(patient_id) REFERENCES patients (id), 
	FOREIGN KEY(updated_by) REFERENCES users (id)
);

CREATE TABLE consents (
	id SERIAL NOT NULL, 
	patient_id INTEGER NOT NULL, 
	agreed BOOLEAN NOT NULL, 
	scope VARCHAR(255) NOT NULL, 
	ai_involved BOOLEAN NOT NULL, 
	operator_id INTEGER, 
	withdrawn_at TIMESTAMP WITHOUT TIME ZONE, 
	created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(patient_id) REFERENCES patients (id), 
	FOREIGN KEY(operator_id) REFERENCES users (id)
);

CREATE TABLE scale_templates (
	id SERIAL NOT NULL, 
	code VARCHAR(16) NOT NULL, 
	name VARCHAR(128) NOT NULL, 
	dimension VARCHAR(32) NOT NULL, 
	method VARCHAR(32) NOT NULL, 
	standard_ref VARCHAR(64) NOT NULL, 
	version VARCHAR(32) NOT NULL, 
	review_status VARCHAR(48) NOT NULL, 
	payload JSON NOT NULL, 
	created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	PRIMARY KEY (id)
);

CREATE TABLE scale_versions (
	id SERIAL NOT NULL, 
	scale_code VARCHAR(16) NOT NULL, 
	version VARCHAR(32) NOT NULL, 
	payload JSON NOT NULL, 
	reviewer VARCHAR(64) NOT NULL, 
	comment TEXT NOT NULL, 
	created_by INTEGER, 
	created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(created_by) REFERENCES users (id)
);

CREATE TABLE assessment_sessions (
	id SERIAL NOT NULL, 
	patient_id INTEGER NOT NULL, 
	scale_code VARCHAR(16) NOT NULL, 
	scale_version VARCHAR(32) NOT NULL, 
	status VARCHAR(24) NOT NULL, 
	mode VARCHAR(16) NOT NULL, 
	proxy_name VARCHAR(64) NOT NULL, 
	proxy_relation VARCHAR(32) NOT NULL, 
	progress INTEGER NOT NULL, 
	current_question VARCHAR(32) NOT NULL, 
	rule_version VARCHAR(32) NOT NULL, 
	created_by INTEGER, 
	reviewer_id INTEGER, 
	review_comment TEXT NOT NULL, 
	started_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	finished_at TIMESTAMP WITHOUT TIME ZONE, 
	reviewed_at TIMESTAMP WITHOUT TIME ZONE, 
	PRIMARY KEY (id), 
	FOREIGN KEY(patient_id) REFERENCES patients (id), 
	FOREIGN KEY(created_by) REFERENCES users (id), 
	FOREIGN KEY(reviewer_id) REFERENCES users (id)
);

CREATE TABLE assessment_answers (
	id SERIAL NOT NULL, 
	session_id INTEGER NOT NULL, 
	question_code VARCHAR(32) NOT NULL, 
	value VARCHAR(255) NOT NULL, 
	score FLOAT, 
	measured FLOAT, 
	skipped BOOLEAN NOT NULL, 
	skip_reason VARCHAR(255) NOT NULL, 
	proxy_flag BOOLEAN NOT NULL, 
	answered_by VARCHAR(64) NOT NULL, 
	answered_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_answer_session_question UNIQUE (session_id, question_code), 
	FOREIGN KEY(session_id) REFERENCES assessment_sessions (id)
);

CREATE TABLE assessment_scores (
	id SERIAL NOT NULL, 
	session_id INTEGER NOT NULL, 
	patient_id INTEGER NOT NULL, 
	scale_code VARCHAR(16) NOT NULL, 
	scale_version VARCHAR(32) NOT NULL, 
	rule_version VARCHAR(32) NOT NULL, 
	total FLOAT NOT NULL, 
	level VARCHAR(64) NOT NULL, 
	interpretation TEXT NOT NULL, 
	abnormal BOOLEAN NOT NULL, 
	severity VARCHAR(16) NOT NULL, 
	flags JSON NOT NULL, 
	explanation TEXT NOT NULL, 
	rule_refs JSON NOT NULL, 
	missing_items JSON NOT NULL, 
	needs_manual_review BOOLEAN NOT NULL, 
	reviewed BOOLEAN NOT NULL, 
	created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(session_id) REFERENCES assessment_sessions (id), 
	FOREIGN KEY(patient_id) REFERENCES patients (id)
);

CREATE TABLE disease_profiles (
	id SERIAL NOT NULL, 
	code VARCHAR(16) NOT NULL, 
	name VARCHAR(64) NOT NULL, 
	aliases JSON NOT NULL, 
	system VARCHAR(32) NOT NULL, 
	risk_level VARCHAR(16) NOT NULL, 
	review_status VARCHAR(48) NOT NULL, 
	payload JSON NOT NULL, 
	created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	PRIMARY KEY (id)
);

CREATE TABLE disease_symptoms (
	id SERIAL NOT NULL, 
	disease_code VARCHAR(16) NOT NULL, 
	symptom_code VARCHAR(48) NOT NULL, 
	weight VARCHAR(16) NOT NULL, 
	PRIMARY KEY (id)
);

CREATE TABLE disease_differentials (
	id SERIAL NOT NULL, 
	disease_code VARCHAR(16) NOT NULL, 
	vs_code VARCHAR(16) NOT NULL, 
	features JSON NOT NULL, 
	points FLOAT NOT NULL, 
	reason TEXT NOT NULL, 
	PRIMARY KEY (id)
);

CREATE TABLE alert_thresholds (
	id SERIAL NOT NULL, 
	scope VARCHAR(16) NOT NULL, 
	disease_code VARCHAR(16) NOT NULL, 
	threshold FLOAT NOT NULL, 
	level VARCHAR(16) NOT NULL, 
	review_status VARCHAR(48) NOT NULL, 
	updated_by VARCHAR(64) NOT NULL, 
	comment TEXT NOT NULL, 
	created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	PRIMARY KEY (id)
);

CREATE TABLE matching_rules (
	id SERIAL NOT NULL, 
	key VARCHAR(48) NOT NULL, 
	value FLOAT NOT NULL, 
	description VARCHAR(255) NOT NULL, 
	updated_by VARCHAR(64) NOT NULL, 
	updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (key)
);

CREATE TABLE match_runs (
	id SERIAL NOT NULL, 
	patient_id INTEGER NOT NULL, 
	input_snapshot JSON NOT NULL, 
	thresholds JSON NOT NULL, 
	rule_version VARCHAR(32) NOT NULL, 
	model_version VARCHAR(64) NOT NULL, 
	created_by INTEGER, 
	created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(patient_id) REFERENCES patients (id), 
	FOREIGN KEY(created_by) REFERENCES users (id)
);

CREATE TABLE match_candidates (
	id SERIAL NOT NULL, 
	run_id INTEGER NOT NULL, 
	disease_code VARCHAR(16) NOT NULL, 
	disease_name VARCHAR(64) NOT NULL, 
	rank INTEGER NOT NULL, 
	match_score FLOAT NOT NULL, 
	ref_probability FLOAT NOT NULL, 
	raw_score FLOAT NOT NULL, 
	hit_symptoms JSON NOT NULL, 
	missing_symptoms JSON NOT NULL, 
	excluded_reasons JSON NOT NULL, 
	risk_level VARCHAR(16) NOT NULL, 
	advice JSON NOT NULL, 
	evidence_insufficient BOOLEAN NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(run_id) REFERENCES match_runs (id)
);

CREATE TABLE alerts (
	id SERIAL NOT NULL, 
	patient_id INTEGER NOT NULL, 
	match_run_id INTEGER, 
	level VARCHAR(16) NOT NULL, 
	message TEXT NOT NULL, 
	department VARCHAR(64) NOT NULL, 
	disclaimer TEXT NOT NULL, 
	status VARCHAR(16) NOT NULL, 
	handled_by VARCHAR(64) NOT NULL, 
	handled_at TIMESTAMP WITHOUT TIME ZONE, 
	handle_comment TEXT NOT NULL, 
	created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(patient_id) REFERENCES patients (id), 
	FOREIGN KEY(match_run_id) REFERENCES match_runs (id)
);

CREATE TABLE cga_reports (
	id SERIAL NOT NULL, 
	patient_id INTEGER NOT NULL, 
	version INTEGER NOT NULL, 
	title VARCHAR(128) NOT NULL, 
	sections JSON NOT NULL, 
	disclaimer TEXT NOT NULL, 
	locked BOOLEAN NOT NULL, 
	created_by INTEGER, 
	created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(patient_id) REFERENCES patients (id), 
	FOREIGN KEY(created_by) REFERENCES users (id)
);

CREATE TABLE followups (
	id SERIAL NOT NULL, 
	patient_id INTEGER NOT NULL, 
	interval_days INTEGER NOT NULL, 
	focus_items JSON NOT NULL, 
	due_at TIMESTAMP WITHOUT TIME ZONE, 
	status VARCHAR(16) NOT NULL, 
	note TEXT NOT NULL, 
	result TEXT NOT NULL, 
	created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	completed_at TIMESTAMP WITHOUT TIME ZONE, 
	PRIMARY KEY (id), 
	FOREIGN KEY(patient_id) REFERENCES patients (id)
);

CREATE TABLE ai_dialogue_sessions (
	id SERIAL NOT NULL, 
	patient_id INTEGER NOT NULL, 
	title VARCHAR(128) NOT NULL, 
	model VARCHAR(64) NOT NULL, 
	prompt_version VARCHAR(32) NOT NULL, 
	created_by INTEGER, 
	created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(patient_id) REFERENCES patients (id), 
	FOREIGN KEY(created_by) REFERENCES users (id)
);

CREATE TABLE ai_dialogue_turns (
	id SERIAL NOT NULL, 
	session_id INTEGER NOT NULL, 
	role VARCHAR(16) NOT NULL, 
	content TEXT NOT NULL, 
	extracted JSON NOT NULL, 
	safety_note TEXT NOT NULL, 
	conflict_flags JSON NOT NULL, 
	created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(session_id) REFERENCES ai_dialogue_sessions (id)
);

CREATE TABLE patient_medical_profiles (
	id SERIAL NOT NULL, 
	patient_id INTEGER NOT NULL, 
	symptoms JSON NOT NULL, 
	conditions JSON NOT NULL, 
	medications JSON NOT NULL, 
	lifestyle JSON NOT NULL, 
	chief_complaint JSON NOT NULL, 
	source VARCHAR(32) NOT NULL, 
	updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(patient_id) REFERENCES patients (id)
);

CREATE TABLE periodic_assessments (
	id SERIAL NOT NULL, 
	patient_id INTEGER NOT NULL, 
	dimension_conclusions JSON NOT NULL, 
	trend JSON NOT NULL, 
	model VARCHAR(64) NOT NULL, 
	prompt_version VARCHAR(32) NOT NULL, 
	input_snapshot JSON NOT NULL, 
	notice TEXT NOT NULL, 
	generated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(patient_id) REFERENCES patients (id)
);

CREATE TABLE prompt_templates (
	id SERIAL NOT NULL, 
	code VARCHAR(48) NOT NULL, 
	name VARCHAR(64) NOT NULL, 
	version VARCHAR(32) NOT NULL, 
	content TEXT NOT NULL, 
	active BOOLEAN NOT NULL, 
	created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	PRIMARY KEY (id)
);

CREATE TABLE audit_logs (
	id SERIAL NOT NULL, 
	actor_id INTEGER, 
	actor_name VARCHAR(64) NOT NULL, 
	action VARCHAR(48) NOT NULL, 
	target_type VARCHAR(32) NOT NULL, 
	target_id VARCHAR(48) NOT NULL, 
	detail JSON NOT NULL, 
	created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(actor_id) REFERENCES users (id)
);

CREATE TABLE template_approvals (
	id SERIAL NOT NULL, 
	target_type VARCHAR(32) NOT NULL, 
	target_id VARCHAR(48) NOT NULL, 
	action VARCHAR(24) NOT NULL, 
	reviewer VARCHAR(64) NOT NULL, 
	comment TEXT NOT NULL, 
	created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	PRIMARY KEY (id)
);

CREATE TABLE model_runs (
	id SERIAL NOT NULL, 
	task VARCHAR(48) NOT NULL, 
	model VARCHAR(64) NOT NULL, 
	prompt_version VARCHAR(32) NOT NULL, 
	latency_ms INTEGER NOT NULL, 
	input_snapshot JSON NOT NULL, 
	output_snapshot JSON NOT NULL, 
	created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	PRIMARY KEY (id)
);

CREATE UNIQUE INDEX ix_users_username ON users (username);
CREATE INDEX ix_users_role ON users (role);
CREATE UNIQUE INDEX ix_patients_code ON patients (code);
CREATE INDEX ix_patients_name ON patients (name);
CREATE UNIQUE INDEX ix_preconsults_patient_id ON preconsults (patient_id);
CREATE INDEX ix_consents_patient_id ON consents (patient_id);
CREATE INDEX ix_scale_templates_dimension ON scale_templates (dimension);
CREATE UNIQUE INDEX ix_scale_templates_code ON scale_templates (code);
CREATE INDEX ix_scale_versions_scale_code ON scale_versions (scale_code);
CREATE INDEX ix_assessment_sessions_scale_code ON assessment_sessions (scale_code);
CREATE INDEX ix_assessment_sessions_patient_id ON assessment_sessions (patient_id);
CREATE INDEX ix_assessment_sessions_status ON assessment_sessions (status);
CREATE INDEX ix_assessment_answers_session_id ON assessment_answers (session_id);
CREATE INDEX ix_assessment_scores_scale_code ON assessment_scores (scale_code);
CREATE INDEX ix_assessment_scores_patient_id ON assessment_scores (patient_id);
CREATE INDEX ix_assessment_scores_session_id ON assessment_scores (session_id);
CREATE INDEX ix_disease_profiles_name ON disease_profiles (name);
CREATE UNIQUE INDEX ix_disease_profiles_code ON disease_profiles (code);
CREATE INDEX ix_disease_symptoms_symptom_code ON disease_symptoms (symptom_code);
CREATE INDEX ix_disease_symptoms_disease_code ON disease_symptoms (disease_code);
CREATE INDEX ix_disease_differentials_disease_code ON disease_differentials (disease_code);
CREATE INDEX ix_alert_thresholds_scope ON alert_thresholds (scope);
CREATE INDEX ix_match_runs_patient_id ON match_runs (patient_id);
CREATE INDEX ix_match_candidates_run_id ON match_candidates (run_id);
CREATE INDEX ix_match_candidates_disease_code ON match_candidates (disease_code);
CREATE INDEX ix_alerts_patient_id ON alerts (patient_id);
CREATE INDEX ix_alerts_level ON alerts (level);
CREATE INDEX ix_alerts_status ON alerts (status);
CREATE INDEX ix_cga_reports_patient_id ON cga_reports (patient_id);
CREATE INDEX ix_followups_patient_id ON followups (patient_id);
CREATE INDEX ix_followups_status ON followups (status);
CREATE INDEX ix_ai_dialogue_sessions_patient_id ON ai_dialogue_sessions (patient_id);
CREATE INDEX ix_ai_dialogue_turns_session_id ON ai_dialogue_turns (session_id);
CREATE UNIQUE INDEX ix_patient_medical_profiles_patient_id ON patient_medical_profiles (patient_id);
CREATE INDEX ix_periodic_assessments_patient_id ON periodic_assessments (patient_id);
CREATE INDEX ix_prompt_templates_code ON prompt_templates (code);
CREATE INDEX ix_audit_logs_action ON audit_logs (action);
CREATE INDEX ix_audit_logs_created_at ON audit_logs (created_at);
CREATE INDEX ix_template_approvals_target_id ON template_approvals (target_id);
CREATE INDEX ix_template_approvals_target_type ON template_approvals (target_type);
CREATE INDEX ix_model_runs_task ON model_runs (task);

COMMIT;
