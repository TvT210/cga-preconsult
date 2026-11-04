# API 契约（/api/v1）

> 后端 FastAPI 实现，前端按此契约开发。响应统一 `{"code":0,"message":"ok","data":{...}}` 包装，
> 错误码 `code != 0`；鉴权头 `Authorization: Bearer <token>`。
> 开发端口：后端 `http://127.0.0.1:8000`，前端 `http://127.0.0.1:3000`，前端通过 `NEXT_PUBLIC_API_BASE` 指向后端。

## 角色

`elder`（老人/家属）、`staff`（评估人员/护士）、`doctor`（医生）、`admin`（系统管理员）。

## 1. 认证 `/auth`

| 方法 | 路径 | 说明 | 权限 |
| --- | --- | --- | --- |
| POST | `/auth/login` | body `{username, password}` → `{token, user:{id,username,role,full_name,patient_id}}` | 公开 |
| GET | `/auth/me` | 当前用户 | 登录 |

预置账号（种子脚本）：`admin/admin12345`（admin）、`doctor/doctor12345`（doctor）、`nurse/nurse12345`（staff）、`elder/elder12345`（elder，绑定演示患者 `P0001`）。

## 2. 患者与预问诊 `/patients`

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/patients?keyword=&page=&size=` | 列表（staff/doctor/admin；elder 只能取本人） |
| POST | `/patients` | 创建：`{name, gender, birth_date, phone, id_card?, address?, emergency_contact?}` |
| GET | `/patients/{id}` | 详情 |
| PUT | `/patients/{id}` | 修改基础信息 |
| GET | `/patients/{id}/preconsult` | 预问诊内容 |
| PUT | `/patients/{id}/preconsult` | **增量保存**（部分字段即更新），body 为预问诊结构 |
| POST | `/patients/{id}/consent` | `{agreed: bool, scope?: string, withdraw?: bool}` → 同意记录 |
| GET | `/patients/{id}/consents` | 同意历史 |
| GET | `/patients/{id}/timeline` | 时间轴：评估／报告／对话／提醒 |

预问诊 body 结构（字段均为可选，增量保存）：

```json
{
  "basic": { "gender": "女", "birth_date": "1948-05-12", "marital_status": "丧偶", "education": "小学", "living_status": "独居", "medical_insurance": "职工医保", "contact_name": "邱某", "contact_phone": "13800000000" },
  "chief_complaint": { "text": "反复头晕 3 天", "onset": "3天前", "site": "头部", "nature": "昏沉", "severity": 3, "course": "间断", "associated": ["乏力"] },
  "history": { "conditions": ["高血压", "2型糖尿病"], "medications": [{"name": "氨氯地平", "dose": "5mg qd", "since": "2023"}], "allergies": [{"name": "青霉素", "reaction": "皮疹"}] },
  "lifestyle": { "smoking": false, "drinking": false, "diet": "普通饮食", "activity": "每日散步20分钟", "sleep": "入睡困难", "falls": [{"time": "2026-10-20", "place": "卫生间", "cause": "地面湿滑", "injury": "轻微擦伤"}] },
  "proxy": { "is_proxy": true, "proxy_name": "邱某", "proxy_relation": "女儿" }
}
```

## 3. 量表中心 `/scales`

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/scales` | 量表清单：`[{code,name,dimension,method,review_status,item_count,version}]` |
| GET | `/scales/{code}` | 详情：`{code,name,dimension,method,standard_ref,review_status,collection,sections:[{code,title,questions:[{code,text,plain_text,input_type,required,options:[{value,label,score}],unit?}]}],scoring,branches,notes}` |
| GET | `/scales/{code}/versions` | 版本历史 |
| POST | `/scales` | 新增量表（admin），body 同详情结构 |
| PUT | `/scales/{code}/review` | `{review_status: "approved" | "draft_pending_medical_review", reviewer, comment}`（admin/doctor） |

`review_status` 取值：`draft_pending_medical_review`（草稿，不可出正式结论）、`approved`（已评审）、`deprecated`。

## 4. 评估会话 `/assessments`

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/assessments` | `{patient_id, scale_code, mode: "patient"|"staff", proxy_name?, proxy_relation?}` → 会话 |
| GET | `/assessments/{id}` | `{id,patient_id,scale_code,scale_name,status,progress,current_question,questions,answers,mode,proxy}` |
| POST | `/assessments/{id}/answers` | `{question_code, value, measured?, proxy_flag?, answered_by?}` → `{answer, next_question, progress}` |
| POST | `/assessments/{id}/skip` | `{question_code, reason}` 跳过（记为缺项） |
| POST | `/assessments/{id}/finish` | 完成 → `{scores:[{scale_code,total,level,interpretation,abnormal,severity,flags,explanation,rule_refs}], branches:[{target_scale,reason}], needs_manual_review}` |
| POST | `/assessments/{id}/review` | 医护复核 `{action:"approve"|"correct", corrections:[{question_code,value}], comment}` |
| GET | `/assessments?patient_id=&scale_code=&status=` | 列表 |
| GET | `/patients/{id}/assessments` | 患者名下全部评估 |

`status`：`in_progress` / `finished` / `reviewed` / `abandoned`。

## 5. 报告 `/reports`

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/reports` | `{patient_id, assessment_ids?: [], title?}` → 生成（自动汇总该患者最近一次各量表结果） |
| GET | `/reports?patient_id=` | 列表 |
| GET | `/reports/{id}` | `{id,patient_id,version,locked,sections:{basic,scale_results,dimension_summary,positive_list,ai_supplement,disease_match,interventions,mdt_opinions,followup_plan},disclaimer}` |
| POST | `/reports/{id}/lock` | 归档锁版本（后续修改需新建版本） |
| GET | `/reports/{id}/export?format=docx\|pdf` | 文件下载 |

## 6. 疾病库与匹配 `/diseases`、`/matching`

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/diseases` | `{diseases:[{code,name,system,risk_level,symptom_count,review_status}], thresholds:[...]}` |
| GET | `/diseases/{code}` | 详情（含症状权重、鉴别要点、关联量表、建议） |
| POST | `/matching/run` | `{patient_id}` → 匹配批次 |
| GET | `/matching/runs?patient_id=` | 批次列表 |
| GET | `/matching/runs/{id}` | `{id,patient_id,created_at,thresholds,candidates:[{disease_code,disease_name,match_score,ref_probability,hit_symptoms:[{code,term,weight}],missing_symptoms:[...],excluded_reasons:[...],risk_level,advice}],alert:{level,message,department,disclaimer},disclaimer}` |
| GET | `/matching/thresholds` | 阈值列表 `{scope, disease_code, threshold, level, review_status}` |
| PUT | `/matching/thresholds/{id}` | 修改（admin/doctor，写审计） |

**术语约束（强制）**：对外字段只用 `match_score`（匹配度，0~100）、`ref_probability`（参考概率，0~100），
文案用「匹配度」「参考概率」，禁止「确诊概率」「患病概率」。所有匹配结果与提醒必须带
`disclaimer = "结果仅供参考，不构成诊断，请及时咨询医生。"`

## 7. AI 对话 `/dialogue`

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/dialogue/sessions` | `{patient_id}` → 会话 |
| GET | `/dialogue/sessions/{id}` | `{id,patient_id,turns:[{role,content,extracted,safety_note,created_at}],profile}` |
| POST | `/dialogue/sessions/{id}/messages` | `{content, proxy?}` → `{reply, extracted, safety_note, conflict_flags, disclaimer}` |
| POST | `/dialogue/sessions/{id}/messages/stream` | 同上，SSE 流式返回 `data: {...}` |
| GET | `/dialogue/sessions/{id}/profile` | 老人专属医疗数据库画像 `{symptoms:[],conditions:[],medications:[],lifestyle:{},updated_at}` |

`extracted` 结构：`{symptoms:[{code,term,source,confidence}], conditions:[], medications:[], lifestyle:{}, chief_complaint:{}}`。
`conflict_flags`：与量表结果冲突时返回 `[{field, dialogue_value, scale_value, note}]`，不自动覆盖任一方。

## 8. 定期评估、随访、提醒

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/periodic/run` | `{patient_id}` → 手动触发「AI 补充评估」，返回 `{id,patient_id,dimension_conclusions:[],trend:[],model,prompt_version,generated_at,notice}`，`notice` 固定含「AI 补充评估，不替代正式量表施测」 |
| GET | `/periodic?patient_id=` | 历史 |
| GET | `/followups?patient_id=` | 随访计划 |
| POST | `/followups` | `{patient_id, interval_days, focus_items:[], due_at, note}` |
| POST | `/followups/{id}/complete` | `{result, next_interval_days?}` |
| GET | `/alerts?patient_id=&status=` | 就医提醒 `{id,patient_id,level,message,department,status,created_at,handled_by,handled_at}` |
| POST | `/alerts/{id}/handle` | `{action:"ack"|"escalate"|"close", comment}` |

`level`：`immediate`（立即就医）/ `urgent`（尽快就医）/ `elective`（择期就诊）/ `observe`（居家观察）。

## 9. 管理与质控 `/admin`

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/admin/users` / POST | 用户与角色管理（admin） |
| GET | `/admin/audit-logs?actor=&target=&from=&to=&limit=` | 审计日志 |
| GET | `/admin/quality-metrics` | `{scoring_consistency, match_accuracy, false_alert_rate, alert_response_rate, pending_reviews, stats}` |
| GET | `/admin/stats/overview` | 看板汇总：患者数、评估数、报告数、待复核、提醒数 |
| GET | `/admin/prompt-templates` | 提示词模板与版本 |

## 10. 通用约定

- 列表统一返回 `{items:[], total, page, size}`。
- 时间统一 ISO8601 字符串。
- 患者数据访问：elder 仅限 `patient_id` 绑定的本人数据（后端强制）。
- 所有写操作写审计日志（操作人、对象、动作、时间、前后值摘要）。
