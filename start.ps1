<#
.SYNOPSIS
    一键启动：老年人就医预问诊与老年综合评估系统（本地演示环境）

.DESCRIPTION
    自动检查并准备 Python 虚拟环境与前端依赖，然后启动后端（FastAPI, 8000）
    与前端（Next.js, 3000）。数据库默认使用 SQLite（backend\data\cga.db），
    无需安装 PostgreSQL / Redis / Docker。

.PARAMETER Backend
    只启动后端。

.PARAMETER Frontend
    只启动前端。

.PARAMETER Check
    只做环境检查并打印结论，不启动任何服务。

.PARAMETER Reinstall
    强制重新安装依赖（后端 pip / 前端 pnpm）。

.EXAMPLE
    .\start.ps1
    起后端 + 前端，各开一个独立窗口。

.EXAMPLE
    .\start.ps1 -Check
    检查环境是否就绪。
#>
[CmdletBinding()]
param(
    [switch]$Backend,
    [switch]$Frontend,
    [switch]$Check,
    [switch]$Reinstall
)

$ErrorActionPreference = 'Stop'
$Root      = Split-Path -Parent $MyInvocation.MyCommand.Path
$BackendDir  = Join-Path $Root 'backend'
$FrontendDir = Join-Path $Root 'frontend'
$VenvPython  = Join-Path $BackendDir '.venv\Scripts\python.exe'
$VenvPip     = Join-Path $BackendDir '.venv\Scripts\pip.exe'

function Write-Step  ($m) { Write-Host "  [*] $m" -ForegroundColor Cyan }
function Write-Ok    ($m) { Write-Host "  [OK] $m" -ForegroundColor Green }
function Write-Warn2 ($m) { Write-Host "  [!] $m" -ForegroundColor Yellow }
function Write-Err   ($m) { Write-Host "  [X] $m" -ForegroundColor Red }

function Test-Command($name) {
    return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

function Test-PortBusy($port) {
    try {
        $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
        return [bool]$c
    } catch {
        return $false
    }
}

function Wait-Health($url, $timeoutSec) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3
            if ($r.StatusCode -eq 200) { return $true }
        } catch { }
        Start-Sleep -Milliseconds 800
    }
    return $false
}

Write-Host ""
Write-Host "  老年人就医预问诊与老年综合评估系统 - 本地启动" -ForegroundColor White
Write-Host "  ==============================================" -ForegroundColor DarkGray
Write-Host ""

# ---------- 1. 基础环境 ----------
Write-Step "检查基础环境"

if (Test-Command 'python') {
    $pyVer = (& python --version) 2>&1
    Write-Ok "python: $pyVer"
} else {
    Write-Err "未找到 python，请先安装 Python 3.12 并加入 PATH"
    exit 1
}

if (Test-Command 'node') {
    $nodeVer = (& node --version) 2>&1
    Write-Ok "node: $nodeVer"
} else {
    Write-Err "未找到 node，请先安装 Node.js 20+"
    exit 1
}

if (Test-Command 'pnpm') {
    $pnpmVer = (& pnpm --version) 2>&1
    Write-Ok "pnpm: $pnpmVer"
} else {
    Write-Warn2 "未找到 pnpm，尝试启用 corepack"
    try { & corepack enable | Out-Null; & corepack prepare pnpm@latest --activate | Out-Null } catch { }
    if (Test-Command 'pnpm') { Write-Ok "pnpm 已就绪" }
    else { Write-Err "pnpm 不可用，请执行: npm i -g pnpm"; exit 1 }
}

# ---------- 2. 后端依赖 ----------
Write-Step "检查后端依赖"

if (-not (Test-Path $VenvPython)) {
    Write-Warn2 "未找到虚拟环境，创建 backend\.venv"
    Push-Location $BackendDir
    & python -m venv .venv
    Pop-Location
    $Reinstall = $true
}

if ($Reinstall) {
    Write-Step "安装后端依赖（requirements.txt）"
    Push-Location $BackendDir
    & $VenvPython -m pip install --upgrade pip --quiet
    & $VenvPython -m pip install -r requirements.txt
    if ($LASTEXITCODE -ne 0) { Write-Err "后端依赖安装失败"; exit 1 }
    Pop-Location
    Write-Ok "后端依赖安装完成"
} else {
    $probe = & $VenvPython -c "import fastapi, sqlalchemy, uvicorn; print('ok')" 2>&1
    if ($probe -match 'ok') {
        Write-Ok "后端依赖已就绪"
    } else {
        Write-Warn2 "依赖不完整，自动安装"
        Push-Location $BackendDir
        & $VenvPython -m pip install -r requirements.txt
        Pop-Location
        Write-Ok "后端依赖安装完成"
    }
}

# ---------- 3. 前端依赖 ----------
Write-Step "检查前端依赖"

$nodeModules = Join-Path $FrontendDir 'node_modules'
if ($Reinstall -or -not (Test-Path $nodeModules)) {
    Write-Step "安装前端依赖（pnpm install，首次约 1-3 分钟）"
    Push-Location $FrontendDir
    & pnpm install
    if ($LASTEXITCODE -ne 0) { Write-Err "前端依赖安装失败"; exit 1 }
    Pop-Location
    Write-Ok "前端依赖安装完成"
} else {
    Write-Ok "前端依赖已就绪"
}

# ---------- 4. 环境检查视图 ----------
$portBackend = Test-PortBusy 8000
$portFrontend = Test-PortBusy 3000

if ($Check) {
    Write-Host ""
    Write-Host "  ---- 环境检查结论 ----" -ForegroundColor White
    if ($portBackend)  { Write-Warn2 "端口 8000 已被占用（可能有后端在跑）" } else { Write-Ok "端口 8000 可用" }
    if ($portFrontend) { Write-Warn2 "端口 3000 已被占用（可能有前端在跑）" } else { Write-Ok "端口 3000 可用" }
    Write-Ok "环境已就绪，执行 .\start.ps1 即可启动"
    Write-Host ""
    exit 0
}

# ---------- 5. 启动 ----------
$startAll = (-not $Backend) -and (-not $Frontend)

if ($Backend -or $startAll) {
    if ($portBackend) {
        Write-Warn2 "端口 8000 已被占用，跳过后端启动"
    } else {
        Write-Step "启动后端 http://127.0.0.1:8000（同时监听局域网，供手机扫码访问）"
        Start-Process -FilePath 'powershell' `
            -ArgumentList '-NoExit', '-Command', "Set-Location '$BackendDir'; & '$VenvPython' -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000" `
            -WindowStyle Normal
    }
}

if ($Frontend -or $startAll) {
    if ($portFrontend) {
        Write-Warn2 "端口 3000 已被占用，跳过前端启动"
    } else {
        Write-Step "启动前端 http://127.0.0.1:3000"
        Start-Process -FilePath 'powershell' `
            -ArgumentList '-NoExit', '-Command', "Set-Location '$FrontendDir'; pnpm dev --port 3000" `
            -WindowStyle Normal
    }
}

# ---------- 6. 等待后端就绪 ----------
if ($Backend -or $startAll) {
    Write-Step "等待后端就绪（最多 90 秒）"
    if (Wait-Health 'http://127.0.0.1:8000/health' 90) {
        Write-Ok "后端已就绪"
    } else {
        Write-Warn2 "后端在 90 秒内未就绪，请查看后端窗口的报错"
    }
}

Write-Host ""
Write-Host "  ---- 访问信息 ----" -ForegroundColor White
Write-Host "  老人端      http://127.0.0.1:3000/elder"    -ForegroundColor Gray
Write-Host "  医护端      http://127.0.0.1:3000/staff"    -ForegroundColor Gray
Write-Host "  API 文档    http://127.0.0.1:8000/docs"     -ForegroundColor Gray
Write-Host "  健康检查    http://127.0.0.1:8000/health"   -ForegroundColor Gray
Write-Host ""
Write-Host "  想在手机上填：打开老人端，点右上角「用手机填写」，扫二维码即可。" -ForegroundColor Gray
Write-Host "  首次使用若手机打不开，请在 Windows 防火墙放行 3000 与 8000 端口的专用网络访问。" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  ---- 演示账号 ----" -ForegroundColor White
Write-Host "  老人   elder   / elder12345"   -ForegroundColor Gray
Write-Host "  医生   doctor  / doctor12345"  -ForegroundColor Gray
Write-Host "  护士   nurse   / nurse12345"   -ForegroundColor Gray
Write-Host "  管理   admin   / admin12345"   -ForegroundColor Gray
Write-Host ""
Write-Host "  关闭服务：直接关掉弹出的两个终端窗口即可。" -ForegroundColor DarkGray
Write-Host ""
