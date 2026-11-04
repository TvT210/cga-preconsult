# 安装与部署手册（Install.md）

> 适用仓库：`老年人就医预问诊与老年综合评估系统`（前后端分离）
> 目标环境：本机 Windows 11 + PowerShell 5.1（**不支持 `&&` 连接符，命令请逐条执行**）
> 相关文档：根 `README.md`（项目手册）、`AGENT.md`（约定与领域红线）、`docs/api-contract.md`（API 契约）

---

## 1. 环境要求

| 组件 | 版本要求 | 是否必需 | 说明 |
| --- | --- | --- | --- |
| 操作系统 | Windows 11 / Linux / macOS | 必需 | 本项目开发与联调实测于 Windows 11 |
| Shell | PowerShell 5.1+ 或 Bash | 必需 | 本仓库文档命令默认 PowerShell |
| Python | 3.12 | 必需 | 后端运行环境 |
| Node.js | 20+（本机实测 24） | 必需 | 前端构建与运行 |
| pnpm | 9+（本机实测 10） | 必需 | 前端包管理器 |
| Git for Windows | 2.4x+ | 必需 | 克隆仓库；本机实测 2.53，凭据走 Windows 凭据管理器 + Git Credential Manager |
| PostgreSQL | 15+ | 可选 | 生产数据库；本地演示默认 SQLite |
| Redis | 7+ | 可选 | 定期自动评估等异步任务（Celery）所需 |
| Docker Desktop | 最新稳定版 | 可选 | 一键起 PostgreSQL／Redis；**本机已安装但守护进程默认未启动** |

> 本机现状：Docker Desktop 已安装但守护进程默认未启动，PostgreSQL／Redis 未预装，**本地演示走 SQLite**（`backend/data/cga.db`，零外部依赖）。

---

## 2. 安装步骤

### 2.1 克隆仓库

```powershell
cd D:\ALLCODE\work\word2
```

若尚未克隆：

```powershell
git clone <仓库地址>
```

### 2.2 后端：虚拟环境与依赖

```powershell
cd D:\ALLCODE\work\word2\backend
```

```powershell
python -m venv .venv
```

```powershell
.\.venv\Scripts\Activate.ps1
```

```powershell
pip install -r requirements.txt
```

> 若 PowerShell 提示禁止运行脚本，先执行：`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`。

### 2.3 前端：依赖安装

```powershell
cd D:\ALLCODE\work\word2\frontend
```

```powershell
pnpm install
```

### 2.4 环境变量配置

**方式一（推荐，后端 `.env`）**：在 `backend/.env` 中配置，`config.yaml` 可覆盖同名项。

```text
# 后端
APP_ENV=dev
DATABASE_URL=sqlite:///./data/cga.db
SECRET_KEY=请替换为随机长字符串
ACCESS_TOKEN_EXPIRE_MINUTES=120
CORS_ORIGINS=http://127.0.0.1:3000
LLM_PROVIDER=mock
```

**方式二（根 `config.yaml`）**：以仓库根目录 `config.example.yaml` 为模板复制为 `config.yaml`（`config.yaml` 不入库）。

```powershell
cd D:\ALLCODE\work\word2
```

```powershell
Copy-Item -LiteralPath 'config.example.yaml' -Destination 'config.yaml'
```

> 若当前本地副本尚未提供 `config.example.yaml`，可按上述 `.env` 键名直接编写 `config.yaml`，或统一使用 `backend/.env`。实际键名以 `backend` 的配置读取实现为准。

**前端**：用编辑器新建 `frontend/.env.local`，写入接口基址（不要用 PowerShell 5.1 的 `Set-Content -Encoding UTF8` 写入，避免带入 BOM）。

```text
NEXT_PUBLIC_API_BASE=http://127.0.0.1:8000/api/v1
```

> 后端 API 统一前缀为 `/api/v1`；若前端实现自行拼接该前缀，则将基址改为 `http://127.0.0.1:8000`。

### 2.5 数据库初始化

**SQLite（本地默认）**：无需任何操作，首次启动后端时自动建表（`backend/data/cga.db`）。

```powershell
cd D:\ALLCODE\work\word2\backend
```

```powershell
python -m uvicorn app.main:app --reload --port 8000
```

**PostgreSQL（生产／联调）**：先建库，再把 `DATABASE_URL` 指向它。

```powershell
createdb -U postgres cga
```

```text
DATABASE_URL=postgresql+psycopg://postgres:你的密码@127.0.0.1:5432/cga
```

> 驱动名按后端实现选择（`postgresql+psycopg` / `postgresql+psycopg2` / 异步驱动对应 `postgresql+asyncpg`）；表结构由应用启动时自动同步或由 `docs/sql/` 中的 DDL 初始化。

**Docker 可选路径**：若仓库提供 `docker-compose.yml`（含 PostgreSQL／Redis 服务），在 Docker Desktop 守护进程已启动的前提下执行：

```powershell
docker compose up -d
```

### 2.6 种子数据

后端启动时**自动播种**：预置账号（`admin` / `doctor` / `nurse` / `elder`）、21 张量表草稿题库、疾病库草稿与阈值初始值。首次启动后确认种子数据已生成：

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:8000/api/v1/health'
```

> 种子数据中的量表与疾病库条目均为 `review_status: draft_pending_medical_review` 的**待评审草稿**，须经医护与医学专家核对 WS/T 888—2026 附录 B 原文后审批发布，方可作为正式医学结论依据。

### 2.7 启动前后端

**后端**（终端 A）：

```powershell
cd D:\ALLCODE\work\word2\backend
```

```powershell
python -m uvicorn app.main:app --reload --port 8000
```

**前端**（终端 B）：

```powershell
cd D:\ALLCODE\work\word2\frontend
```

```powershell
pnpm dev
```

访问地址：后端 `http://127.0.0.1:8000`，OpenAPI 文档 `http://127.0.0.1:8000/docs`，前端 `http://127.0.0.1:3000`。

---

## 3. 常用运维

### 3.1 健康检查与接口自检

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:8000/api/v1/health'
```

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:8000/api/v1/diseases' -Headers @{ Authorization = 'Bearer <token>' }
```

### 3.2 查看日志

后端默认输出到控制台；需要留档时在 `backend/` 目录执行：

```powershell
python -m uvicorn app.main:app --reload --port 8000 2>&1 | Tee-Object -FilePath backend.log
```

前端日志同样在 `pnpm dev` 的终端窗口；生产构建的日志可用：

```powershell
pnpm build
```

```powershell
pnpm start
```

### 3.3 运行测试

```powershell
cd D:\ALLCODE\work\word2\backend
```

```powershell
python -m pytest tests -q
```

### 3.4 停止进程（Windows）

后端与前端通常用 `Ctrl + C` 即可停止。确需按进程停止时，**先确认 PID 归属，禁止无差别批量杀进程**：

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Select-Object ProcessId,CommandLine
```

确认命令行确属本项目后再停止指定进程：

```powershell
Stop-Process -Id <上一步确认的PID>
```

> ⚠️ 不建议直接执行 `Get-Process node | Stop-Process`：会连带结束 IDE、构建工具等无关 Node 进程。同样，清理端口占用时先定位占用进程再操作：

```powershell
Get-NetTCPConnection -LocalPort 8000 -State Listen | Select-Object LocalPort,OwningProcess
```

---

## 4. 常见问题排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| **端口被占用**（`Address already in use`） | 8000／3000 已被其他进程占用 | 用 `Get-NetTCPConnection -LocalPort 8000 -State Listen` 定位占用 PID，确认后 `Stop-Process -Id <PID>`；或改用 `--port 8001` 并同步修改 `NEXT_PUBLIC_API_BASE` |
| **依赖装不上** | pip／pnpm 网络或版本问题 | 升级打包器：`python -m pip install -U pip`、`pnpm self-update`；换国内镜像源；确认 Python 3.12 与 Node 20+；前端报 node_modules 损坏时删除 `node_modules` 后重装 `pnpm install` |
| **数据库连接失败** | `DATABASE_URL` 写错、PostgreSQL 未启动、SQLite 目录不可写 | 检查 `.env`／`config.yaml`；PostgreSQL 服务未起时确认 `pg_isready`；SQLite 场景确认 `backend/data/` 存在且可写 |
| **token 失效 / 401 / 403** | JWT 过期或密钥变更、请求未带 `Authorization: Bearer <token>` | 重新登录取新 token；确认 `SECRET_KEY` 未在运行中变更；老人账号只能访问本人数据，越权访问返回 403 |
| **报告导出报错（Word/PDF）** | 导出依赖缺失或缺少外部转换程序 | 按报错提示补装 `backend/requirements.txt` 中对应的导出依赖；PDF 转换若依赖外部程序（如 Office/LibreOffice），先安装该程序或改用 Word 导出 |
| **Docker 守护进程未启动** | Docker Desktop 未运行 | 启动 Docker Desktop 并等待引擎就绪；**不可用时不必重试**，本地演示直接用 SQLite + 手动触发评估（`POST /api/v1/periodic/run`）替代 Celery 定时任务 |
| **虚拟环境激活失败** | 执行策略限制 | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` 后重试 |
| **中文/乱码或命令不执行** | PowerShell 5.1 不支持 `&&` | 改为分号 `;` 或逐条执行命令 |

---

## 5. 生产部署建议

### 5.1 部署拓扑

```text
浏览器 / 小程序
   │  HTTPS (TLS)
Nginx（静态资源 + /api 反向代理 + /api/v1 长连接/SSE 放行）
   ├── FastAPI（后端，多进程/多副本，受 systemd 或 NSSM 托管）
   │      ├── PostgreSQL 15+（业务库，开启定期备份）
   │      ├── Redis 7（Celery broker 与缓存）
   │      └── Celery Worker + Celery Beat（定期自动评估等异步任务）
   └── 报告归档存储（对象存储 / NAS，保存 PDF、Word 报告）
```

### 5.2 组件建议

| 组件 | 建议 |
| --- | --- |
| Web 服务器 | Nginx：静态资源缓存、`/api` 反代、`/api/v1/dialogue/.../stream` 的 SSE 关闭缓冲（`proxy_buffering off`）、上传体积限制 |
| 进程托管 | Linux 用 systemd（`Restart=always`，非 root 用户运行）；Windows 用 NSSM 注册为服务 |
| 数据库 | PostgreSQL 15+，定期 `pg_dump` 备份；连接串走环境变量注入，不落盘入库 |
| 缓存与队列 | Redis 7，启用密码与持久化；Celery Worker 与 Beat 分离部署 |
| 报告归档 | 导出文件落对象存储 / NAS，数据库只存元数据与版本号；归档时同步锁定报告版本 |
| 密钥管理 | `SECRET_KEY`、大模型 API Key、数据库口令经环境变量或密钥管理服务注入，禁止写入仓库 |

### 5.3 最小权限与审计留痕

- 服务账号使用**非管理员**系统账号，数据库账号按读写分离并仅授予所需 schema 权限。
- 应用侧落实**基于角色的访问控制**：老人仅可访问本人数据；阈值、题库、疾病库、提示词的变更仅限 `admin`／`doctor`，且写入审计日志。
- 审计留痕覆盖：访问、修改、导出、阈值变更、知识库发布、报告归档锁版本。
- 全链路版本留痕：题库版本、规则版本、模型与提示词版本、报告版本随记录保存，支持复盘。
- 传输全程 TLS；敏感字段加密存储；日志脱敏；科研／统计导出必须脱敏。
- 上线前完成**量表与疾病库条目的医学评审与审批发布**（`review_status` 从 `draft_pending_medical_review` 变更为 `approved`），并保留评审记录。

### 5.4 上线检查清单

- [ ] 演示账号口令全部修改，演示患者数据清理
- [ ] 21 张量表与疾病库条目完成医学评审并审批发布
- [ ] 阈值、权重、提示词版本冻结并留痕
- [ ] PostgreSQL 备份与恢复演练通过
- [ ] 日志脱敏、审计日志落盘策略确认
- [ ] 免责声明文案「结果仅供参考，不构成诊断」在所有对外出口生效
