# 前端模块说明（frontend/）

老年人就医预问诊与老年综合评估系统的前端应用。

## 技术栈

| 项目 | 版本 / 说明 |
| --- | --- |
| 框架 | Next.js 15.5.x（App Router，`src/app`） |
| 视图层 | React 19 + TypeScript 5（`strict: true`） |
| 样式 | Tailwind CSS 3.4（`tailwind.config.ts` 内置医疗蓝主题与适老化字号阶梯） |
| 图表 | Recharts 3.10（仅质控看板使用，`/staff/quality` 路由单独打包） |
| 包管理 | pnpm 10.x（Node 24） |
| 校验 | ESLint 8 + `eslint-config-next`（`pnpm lint` 走 ESLint CLI，未用已废弃的 `next lint`） |

## 目录结构

```text
frontend/
├─ src/
│  ├─ app/                       # 路由页面
│  │  ├─ login/                  # 登录（角色快捷入口）
│  │  ├─ elder/                  # 老人端
│  │  │  ├─ page.tsx             # 首页：待评估任务 / 评估记录 / 报告 / 就医提醒
│  │  │  ├─ scale/[id]/          # 量表采集（[id] 为量表编码）
│  │  │  ├─ chat/                # AI 对话
│  │  │  └─ report/              # 报告与提醒
│  │  └─ staff/                  # 医护端
│  │     ├─ page.tsx             # 评估任务列表（紧凑表格 + 多选批量复核/导出）
│  │     ├─ patients/            # 患者管理 + 患者详情聚合页
│  │     │  └─ [id]/             # 患者档案工作区（左列表 + 右详情，主从布局）
│  │     │     ├─ page.tsx       # 入口（< 200 行，只负责取路由参数 + Suspense）
│  │     │     ├─ PatientWorkspace.tsx  # 主从布局壳层、tab 路由同步
│  │     │     ├─ PatientListPanel.tsx  # 左列患者列表（搜索/状态筛选/按最近评估排序）
│  │     │     ├─ usePatientWorkspace.ts# 数据装载与操作（usePatientWorkspace hook）
│  │     │     └─ tabs/          # 预问诊/评估/报告/匹配与提醒/时间轴 五个 tab
│  │     ├─ quality/            # 质控看板（指标卡 + 柱状/折线/环形图）
│  │     ├─ review/[id]/         # 评估复核（左题右答对照 + 改分前后对比）
│  │     └─ config/              # 阈值 / 量表版本评审 / 用户管理
│  ├─ components/                # 通用组件
│  │  ├─ QualityDashboard.tsx    # 质控看板主体（指标卡 + 三张图表）
│  │  ├─ QualityMetricCard.tsx   # 单个指标卡（null → 「暂无数据」）
│  │  ├─ AiReviewPanel.tsx       # AI 语义复核（排序对照/追问建议/通俗解释/分歧）
│  │  ├─ CompactTable.tsx        # 紧凑数据表（列排序 + 密度切换 + 多选）
│  │  ├─ MatchCandidateCard.tsx  # 匹配候选卡（规则排序 / AI 建议排序 / 命中依据分层）
│  │  └─ AlertCard.tsx           # 就医提醒卡（含「标记误报」）
│  └─ lib/                       # api 封装、类型、会话、语音、格式化
└─ scripts/verify-render.mjs     # 无头浏览器渲染自检脚本
```

## 关键约定

1. **接口唯一出口**：`src/lib/api.ts`。基础地址取 `NEXT_PUBLIC_API_BASE`（默认
   `http://127.0.0.1:8000/api/v1`），自动带 `Authorization: Bearer <token>`；
   token 存 `localStorage`（键 `wfdn_token`）。响应统一解包 `{code,message,data}`，
   `code != 0` 抛错并弹提示；401 清理登录态并跳转 `/login`。
2. **类型基线**：`src/lib/types.ts` 与 `docs/api-contract.md` 一一对应，字段名保持后端原样，
   界面文案一律简体中文。
3. **角色守卫**：`RoleGuard` 组件。`/elder` 仅 `elder`，`/staff` 仅 `staff/doctor/admin`；
   登录后按角色跳 `/elder` 或 `/staff`。老人只能访问本人数据由后端强制。
4. **术语红线**：对外只用「匹配度」（`match_score`）与「参考概率」（`ref_probability`），
   禁止「确诊概率」「患病概率」；匹配结果与就医提醒固定附
   「结果仅供参考，不构成诊断，请及时咨询医生。」
5. **适老化**：老人端正文 ≥18px（`text-elder`），按钮最小高度 48px（`min-h-btn`），
   高对比配色（正文 `#1a1a1a`、主操作 `#1d4ed8`），支持 `prefers-reduced-motion`；
   语音播报用 `speechSynthesis`（语速 0.6~1.2 可调、可重复播放），
   语音输入用 `SpeechRecognition`，不支持时隐藏按钮并提示手动输入。
6. **断点续填**：`/elder/scale/[code]` 进入时按「患者 + 量表」查询 `in_progress` 会话，
   有则续填、无则新建；「暂停并退出」会先保存当前作答再返回首页。
7. **接口失败**：所有数据页在请求失败时渲染 `ErrorState` 友好错误态，不出现白屏。
8. **医护端主从布局**：`/staff/patients/[id]` 左侧是可筛选的患者列表，右侧是选中患者的
   五个 tab（预问诊／评估／报告／匹配与提醒／时间轴）。选中患者与当前 tab 写回 URL query
   （`?patient=3&tab=matching`），**刷新不丢、可直接分享链接**；`useSearchParams` 必须在
   `<Suspense>` 内使用，否则 Next 15 构建会报错。
9. **质控看板的权限降级**：`GET /admin/quality-metrics` 仅管理员可访问，医护账号返回 **403**。
   `src/lib/api.ts` 的 `fetchQualityMetrics()` 捕获 403 后自动改用公开接口
   （`/admin/stats/overview` + `/patients` + `/patients/{id}/assessments` + `/alerts` +
   `/matching/runs` + `/diseases`）自行聚合，并返回 `degraded: true` 与 `unavailable` 列表，
   页面据此显示「部分指标需管理员权限」。**不要**改后端权限绕过。
   降级模式下 `scoring_consistency`（计分一致率）与 `false_alert_rate`（误报率）无法计算，
   必须渲染成「暂无数据」而不是 0。
10. **匹配结果双排序**：候选卡片同时展示**规则排序**（`rank`）与 **AI 建议排序**
   （`ai_review.rerank[].ai_rank`），不一致时高亮并提示「请医师裁决」。
   命中依据分三层渲染：区分性症状（`distinctive_symptoms`，强调色）、
   共享症状（`shared_symptoms`，弱化色 + 「多个候选都有，区分度低」）、
   症状组合（`pattern_hits`，单独一行）；`red_flags` 醒目标红且提醒等级不得下调。
11. **AI 复核是建议不是结论**：`POST /matching/runs/{id}/ai-review` 只返回排序建议、
   追问建议、通俗解释与规则分歧，不修改匹配度／参考概率／阈值／提醒等级。
12. **提醒可标记误报**：`POST /alerts/{id}/handle` 支持 `ack` / `escalate` / `close` /
   `mark_false` / `revoke_false`。`mark_false` 会关闭提醒并计入质控看板的误报率，
   界面上必须先弹确认并说明用途。
13. **批量导出需脱敏**：导出内容不含身份证号与联系电话，导出前必须提示
   「仍含个人健康相关信息，请按院内数据管理要求妥善保管与销毁」。

## 常用命令

```powershell
pnpm install        # 安装依赖
pnpm dev            # 开发模式（默认 3000 端口）
pnpm build          # 生产构建
pnpm start          # 运行生产构建
pnpm lint           # ESLint 校验（--max-warnings=0）

# 后端未启动时的渲染自检（需要先 pnpm build && pnpm start）
node scripts/verify-render.mjs http://127.0.0.1:3111
```

> 验证产物写入仓库根目录 `.qa/frontend/`。

## 与后端对接的实测结论（2026-11-04 对着运行中的后端核对）

1. **CORS 白名单**：后端只放行 `http://localhost:3000` 与 `http://127.0.0.1:3000`。
   前端本地起服务必须用 **3000 端口**，否则浏览器会拦截请求、页面只能看到「网络连接失败」。
2. **patient_id 是整数主键**，不是 `P0001` 这类业务编码：
   `GET /patients/1` 有效，`GET /patients/P0001` 返回 422；`User.patient_id` 形如 `1`。
   患者详情里的 `code` 字段才是 `P0001`，展示用 `code`，路由用 `id`。
3. **列表响应形态不统一**，取值时必须兼容：
   | 接口 | 形态 |
   | --- | --- |
   | `/patients`、`/assessments` | `{items,total,page,size}` |
   | `/scales`、`/reports`、`/alerts`、`/matching/runs` | 数组 |
   | `/matching/thresholds` | `{thresholds:[...],weights:[...]}` |
4. **`progress` 是「已作答题数」**（如 `9`），不是百分比；需配合 `total_questions` 换算。
5. **看板字段名**为 `patients/assessments/reports/alerts/pending_review` 等，不是 `patient_count` 之类。
6. **elder 角色后端缺陷（前端已优雅降级，待后端修复）**：
   `GET /assessments`、`GET /reports`、`GET /alerts`、`GET /periodic`、`GET /followups`
   在 elder 令牌下一律返回 500（staff 令牌正常）。 elder 首页与量表采集页因此走「友好错误态」。
   elder 可正常访问 `/scales`、`/patients/{id}`、`/matching/runs`、`/dialogue/sessions`。
7. **质控接口是 admin 专属（2026-11-04 实测）**：
   `GET /admin/quality-metrics` 对 staff/doctor 令牌返回 **403**；
   而 `GET /admin/stats/overview`、`/alerts`、`/matching/runs`、`/diseases`、`/patients`
   对医护令牌均返回 200，因此医护端质控看板走 `fetchQualityMetrics()` 的降级聚合路径。
8. **列表接口比详情接口字段少（容易踩坑）**：
   - `GET /reports` **不返回** `template_code`（只有 `GET /reports/{id}` 返回），
     所以报告列表要用 `template_code` 时必须补一次详情请求；
   - `GET /alerts` **不返回** `is_false_positive`（只有处理接口的响应返回），
     所以降级模式下无法计算误报率，只能标注「需管理员权限」。
9. **报告导出接口需要 Authorization 头**：`GET /reports/{id}/export?format=docx|pdf`
   不能用地址栏直接跳转（不会带 token），前端统一走 `api.ts` 的 `downloadReportFile()`
   取回二进制再触发下载；后端固定文件名 `cga_report_{patient_id}_v{version}.{format}`，
   模板名由前端在下载时拼进文件名。

