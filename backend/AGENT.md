# backend/ 模块指南

> 本文件是 `backend/` 的**模块级深度指南**。跨模块约定见仓库根 `AGENT.md`；接口契约见 `docs/api-contract.md`。

## 1. 技术栈与运行

| 项 | 选型 | 说明 |
| --- | --- | --- |
| Web | FastAPI 0.16x | 统一响应信封 `{code, message, data}` |
| 数据 | SQLAlchemy 2.0 + PostgreSQL / SQLite | 默认 SQLite 便于本地演示 |
| 校验 | Pydantic v2 | 请求体以 `dict` + 显式校验为主，避免过度模型化 |
| 鉴权 | PyJWT + pbkdf2_hmac | 无第三方密码库依赖 |
| 大模型 | `packages/medagent` Provider 抽象 | `mock` 离线可用，`openai_compatible` 接真实服务 |
| 导出 | python-docx（Word）+ reportlab（PDF） | PDF 使用 CID 字体 `STSong-Light`，无需外部字体文件 |

```powershell
cd backend
python -m pip install -r requirements.txt
python -m uvicorn app.main:app --reload --port 8000
python -m pytest tests -q
```

启动时自动建表并播种（幂等）：预置账号、21 张量表、24 个病种、阈值、匹配权重、提示词模板、演示患者 P0001。

预置账号：`admin/admin12345`、`doctor/doctor12345`、`nurse/nurse12345`、`elder/elder12345`（elder 绑定演示患者）。

## 2. 目录职责

```text
backend/
├─ app/
│  ├─ main.py              # 应用入口、CORS、响应信封中间件、路由注册
│  ├─ core/
│  │  ├─ config.py         # Settings：环境变量 > config.yaml > 默认值
│  │  ├─ security.py       # pbkdf2 口令散列 + JWT 签发校验
│  │  └─ deps.py           # get_current_user / require_* / 老人数据隔离
│  ├─ db/
│  │  ├─ base.py           # engine / SessionLocal / Base
│  │  ├─ models.py         # 27 张表：配置类 / 业务类 / 审计类
│  │  └─ init_db.py        # 建表 + 播种（幂等）
│  ├─ api/                 # 路由层：auth patients scales assessments reports matching dialogue admin
│  └─ services/
│     ├─ scales_store.py   # 题库/疾病库读取（JSON 基线 → 数据库版本）
│     ├─ scoring.py        # 计分与判读引擎
│     ├─ matching.py       # 症状—疾病匹配引擎
│     ├─ report.py         # 报告组装 + Word/PDF 导出
│     ├─ dialogue.py       # 对话、抽取、安全边界、冲突标记、定期评估
│     └─ audit.py          # 审计日志与质控指标
├─ packages/medagent/llm.py  # 可插拔大模型 Provider
└─ tests/                   # pytest：计分 / 匹配 / API 端到端
```

## 3. 计分与判读引擎（services/scoring.py）

两阶段设计，**不硬编码任何阈值**：

1. `scoring.score`：算分。`rule_type` 支持
   - `sum`：各题选项分值求和（`config.items[].max_score` 记录满分）；
   - `count_positive`：计数，`mode` 为 `score_positive`（得分 > 0）或 `max_score_equals`（得分 = 满分）。
2. `scoring.levels`：`level_map`，按顺序首个命中的 `min~max` 区间生效，输出 `level` / `interpretation` / `abnormal` / `severity`。
3. `scoring.flags`：`condition` 规则，命中则产出阳性标记并映射 `symptom_codes`（用于匹配引擎）。

条件语法：`{"question": 题目code, "op": "eq|ne|in|lt|lte|gt|gte", "value": ...}`。
`eq/ne/in` 比较**选项 value 字符串**；`lt/lte/gt/gte` 比较**选项 score 数值**。

可解释性：结果 `rule_refs` 记录「规则 → 每题取值/得分/满分」，任一结论都能回溯到具体作答。

兜底：缺项 → `missing_items` 非空且 `needs_manual_review=True`；题库 `review_status != approved` 时同样标记待人工确认，**不强行出正式结论**。

## 4. 匹配引擎（services/matching.py）

`归一化 → 召回（症状倒排）→ 加权打分 → 同症多病鉴别 → Top-N → 分级提醒`

- 匹配度 `match_score` = 命中加权得分 / 该病最高可能得分 × 100，范围 0~100，规则可解释；
- 参考概率 `ref_probability` = 候选间 softmax 归一化后的相对可能性（**不是**患病概率）；
- 鉴别扣分：缺少鉴别特征时扣分，扣分上限为命中得分的 50%，避免把已有证据完全抹掉；扣分理由写入 `excluded_reasons`；
- 至少返回 Top-3 候选；证据不足时补位候选并标记 `evidence_insufficient=true`；
- 分级提醒四档：`immediate` 立即就医 / `urgent` 尽快就医 / `elective` 择期就诊 / `observe` 居家观察；
- 误报控制：核心症状命中 < 2 或证据不足时，提醒等级下调一级；
- 阈值来自 `alert_thresholds` 表（全局 + 病种），修改写审计日志（`app/api/matching.py` 的 `update_threshold`）。

## 5. 新增/调整量表的流程

1. 在 `docs/structured/assessment-scales/B.x.json` 增改题目与规则（该目录是评审前基线）；
2. `python -m app.db.init_db` 或重启服务，播种把 JSON 写入 `scale_templates` 并留 `scale_versions`；
3. 医护评审后调 `PUT /api/v1/scales/{code}/review` 把 `review_status` 置为 `approved`（写 `template_approvals` 与审计日志）；
4. **禁止**在业务代码里改阈值或题目；一切走题库版本 + 审批。

## 6. 后端专属红线

1. 题库条目、计分规则、判读阈值一律以 WS/T 888—2026 附录 B 为准，不得由模型生成或隐式修改；
2. AI 只做采集、抽取、补充评估与通俗解释，禁止输出诊断、治疗方案与加减停药建议；
3. 对外文案只用「匹配度」「参考概率」，禁止「确诊概率」「患病概率」，提醒必须附「仅供参考，不构成诊断」；
4. 老人仅可访问本人数据（`deps.ensure_patient_access` 强制）；
5. 每次评估与匹配都要落题库版本、规则版本、模型与提示词版本；
6. 对话与量表冲突只标记（`dialogue.detect_conflicts`），不自动覆盖任一方结果。

## 7. 测试

```powershell
cd backend
python -m pytest tests -q          # 27 项：计分 / 匹配 / API 端到端
```

`tests/conftest.py` 使用独立 SQLite（系统临时目录），不污染开发库。
