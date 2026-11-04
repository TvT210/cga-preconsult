# 前端模块说明（frontend/）

老年人就医预问诊与老年综合评估系统的前端应用。

## 技术栈

| 项目 | 版本 / 说明 |
| --- | --- |
| 框架 | Next.js 15.5.x（App Router，`src/app`） |
| 视图层 | React 19 + TypeScript 5（`strict: true`） |
| 样式 | Tailwind CSS 3.4（`tailwind.config.ts` 内置医疗蓝主题与适老化字号阶梯） |
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
│  │     ├─ page.tsx             # 评估任务列表
│  │     ├─ patients/            # 患者管理 + 患者详情聚合页
│  │     ├─ review/[id]/         # 评估复核
│  │     └─ config/              # 阈值 / 量表版本评审 / 用户管理
│  ├─ components/                # 通用组件
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

