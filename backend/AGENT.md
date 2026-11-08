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
│  │  ├─ models.py         # 表结构（共享文件，新增字段需两边约定）
│  │  └─ init_db.py        # 建表 + 播种（幂等）
│  ├─ api/                 # 路由层
│  │  ├─ auth.py patients.py scales.py assessments.py dialogue.py   # 线 A：采集侧
│  │  └─ reports.py matching.py alerts.py reviews.py admin.py        # 线 B：结论侧
│  └─ services/
│     ├─ scales_store.py         # 线 A：题库读取
│     ├─ scoring.py dialogue.py  # 线 A：计分引擎、对话与抽取
│     ├─ disease_library.py      # 线 B：疾病库/症状词表读取 + 证据准备
│     ├─ matching.py report.py ai_review.py audit.py                # 线 B：匹配、报告、AI复核、质控
│     └─ prompt_store.py         # 线 B：提示词模板读取（表优先，回落代码内置版本）
├─ packages/medagent/llm.py  # 可插拔大模型 Provider
└─ tests/                   # pytest：计分 / 匹配 / 对话 / AI复核 / API 端到端
```

## 2.1 两条线的边界（2026-11-04 明确）

| 模块 | 线 | 约定 |
| --- | --- | --- |
| 预问诊采集与录入 | **A** | 患者端填写；医护端**只读**（仅「记录知情同意」） |
| 题库、评估会话、对话抽取 | **A** | `services/scoring.py`、`services/dialogue.py`、`services/scales_store.py` |
| 疾病库、症状词表、报告模板 | **B** | `docs/structured/disease-library/**`；读取入口 `services/disease_library.py` |
| 匹配引擎、AI 复核、报告、提醒、复核裁决、质控 | **B** | `services/matching.py` / `ai_review.py` / `report.py` / `audit.py` |
| `db/models.py`、`db/init_db.py` | 共享 | 改动前知会对方；新增表由 B 统一出 Alembic 迁移 |
| `api/__init__.py`、`core/`、`main.py` | B 维护 | A 需改动走「变更申请」 |

> 症状词表分两层：**词条本体**（标准词、分类）归 B；**`synonyms`**（老人怎么说）归 A，
> 改同义词不改变医学定义。

## 2.2 大模型接入（Provider / 提示词 / 密钥）

### 2.2.1 配置来源与优先级

```
环境变量 / .env  >  config.yaml（不入库）  >  代码默认值
```

- 环境变量前缀 `CGA_`：

  | 变量 | 说明 | 默认 |
  | --- | --- | --- |
  | `CGA_LLM_PROVIDER` | `mock` / `openai_compatible` | `mock` |
  | `CGA_LLM_BASE_URL` | OpenAI 兼容地址（到 `/v1`，不含 `/chat/completions`） | 空 |
  | `CGA_LLM_API_KEY` | **密钥，只允许来自环境变量或 `.env`** | 空 |
  | `CGA_LLM_MODEL` | 模型名 | 空 |
  | `CGA_LLM_MAX_TOKENS` | 单次生成 token 上限 | `4000` |
  | `CGA_LLM_TIMEOUT` | 请求超时（秒） | `60` |

- `config.yaml` 读仓库根或 `backend/` 下的同名文件（`.gitignore` 已排除）；
- **敏感项例外**：`llm_api_key`、`jwt_secret` **只允许**来自环境变量或 `.env`。
  即使写进 `config.yaml` 也会被忽略并打警告——避免密钥被人复制、贴单或误提交。

### 2.2.2 接上真实模型

```powershell
# 在本机环境变量里设置（不要写进任何文件）
$env:CGA_LLM_PROVIDER = "openai_compatible"
$env:CGA_LLM_BASE_URL = "https://api.minimax.chat/v1"
$env:CGA_LLM_API_KEY  = "<你的 key>"
$env:CGA_LLM_MODEL    = "MiniMax-M2.7-highspeed"
$env:CGA_LLM_MAX_TOKENS = "4000"
python -c "from packages.medagent.llm import get_provider; print(get_provider().name)"
```

未设 `CGA_LLM_BASE_URL` 或 provider 不是 `openai_compatible` 时自动回落 `MockProvider`
（离线可跑、结果确定性，用于演示与自动化测试）。

### 2.2.3 推理模型的三个坑（接真实模型必看）

以 MiniMax 为例，实测踩到：

1. **token 预算被 reasoning 吃掉**。推理模型会把 `max_tokens` 花在思考上，
   预算不足时**正文为空、`content` 字段直接缺失**（不是空串）。
   Provider 对此抛 `LLMEmptyResponse` 并提示调大 `CGA_LLM_MAX_TOKENS`。
   实测：`max_tokens=800` → 思考 799、正文 0；`4000` → 思考 1074、正文 466，正常。
2. **思考过程会写进正文**。部分模型（如 `*-highspeed` 变体）返回
   `<think>…</think>` + 正式回答混排。Provider 统一用 `strip_think()` 剥离，
   老人端只应看到正式回答。
3. **延迟差异很大**。实测同一提示词：`M3.1-Flash` 复核 26s（思考 2246 tok），
   `M2.7-highspeed` 复核 6.4s（思考 206 tok）。预问诊逐轮追问用 highspeed 更合适。

### 2.2.4 模型异常不拖垮主流程

- 对话轮次：模型异常/正文为空 → 降级为「抱歉，我没太听清您刚才说的，能再说一遍吗？」，
  并把错误写进 `model_runs.output_snapshot.model_error`；
- AI 复核：模型异常 → 返回空意见 + 提示「AI 复核未完成」，**匹配主流程照常出结果**。

### 2.2.5 三个 AI 调用点与留痕

| 位置 | 作用 | 留痕 |
| --- | --- | --- |
| `services/dialogue.py` 预问诊每轮 | 引导式追问 | `model_runs` task=`dialogue` |
| `services/dialogue.py` 周期评估 | AI 补充评估（四维度） | `model_runs` task=`periodic_assessment` |
| `services/ai_review.py` | 匹配复核：重排建议 / 追问清单 / 通俗解释 / 分歧 | `model_runs` task=`match_ai_review` |

**规则与 AI 的分工**：症状抽取（标准词 + 同义词子串匹配）、计分判读、匹配打分、
报告主体都是**规则**；AI 只做语义消歧与建议，不改分值、阈值、提醒等级，不下诊断结论。

### 2.2.6 提示词模板：表优先，回落内置版本

`services/prompt_store.py::resolve_prompt(db, code, 内置内容, 内置版本)`：

- `prompt_templates` 表里有**生效**版本 → 用它的内容，并记录**它的版本号**；
- 没有 → 用代码内置版本，记录内置版本号。

因此 `model_runs.prompt_version` 永远对应**实际生效的那一版**，事后可复现。

模板编码：`dialogue_guide`（预问诊对话）、`periodic_assessment`（周期补充评估）、
`match_explain`（候选通俗说明）、`match_ai_review`（匹配语义复核）。

**运营改提示词**：`PUT /api/v1/admin/prompt-templates/{id}`（管理员）。
该接口**不覆盖历史行**——旧版本置停用、新版本另起一行，并写审计日志，
保证「某次结论用的是哪版提示词」永远可查。

> 播种规则：只刷新仍处于种子版本 `0.1.0-draft` 的行；运营发布过的行版本号不同，
> 不会被代码升级覆盖。

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
