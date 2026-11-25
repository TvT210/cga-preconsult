#!/usr/bin/env bash
# 一键启动：老年人就医预问诊与老年综合评估系统（本地演示环境）
#
# 用法：
#   ./start.sh            起后端 + 前端
#   ./start.sh backend    只起后端
#   ./start.sh frontend   只起前端
#   ./start.sh check      只做环境检查
#   ./start.sh reinstall  强制重装依赖后启动
#
# 数据库默认 SQLite（backend/data/cga.db），无需 PostgreSQL / Redis / Docker。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT/backend"
FRONTEND_DIR="$ROOT/frontend"
VENV_PY="$BACKEND_DIR/.venv/bin/python"

MODE="${1:-all}"

c_ok()   { printf '  \033[32m[OK]\033[0m %s\n' "$1"; }
c_info() { printf '  \033[36m[*]\033[0m %s\n' "$1"; }
c_warn() { printf '  \033[33m[!]\033[0m %s\n' "$1"; }
c_err()  { printf '  \033[31m[X]\033[0m %s\n' "$1"; }

port_busy() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | grep -q ":$1 " && return 0
  elif command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1 && return 0
  fi
  return 1
}

wait_health() {
  local url="$1" timeout="${2:-90}" i=0
  while [ "$i" -lt "$timeout" ]; do
    if curl -fsS "$url" >/dev/null 2>&1; then return 0; fi
    sleep 1; i=$((i + 1))
  done
  return 1
}

echo ""
echo "  老年人就医预问诊与老年综合评估系统 - 本地启动"
echo "  =============================================="
echo ""

# ---------- 1. 基础环境 ----------
c_info "检查基础环境"
command -v python3 >/dev/null 2>&1 || command -v python >/dev/null 2>&1 || { c_err "未找到 python3"; exit 1; }
PY_BIN="$(command -v python3 || command -v python)"
c_ok "python: $($PY_BIN --version 2>&1)"

command -v node >/dev/null 2>&1 || { c_err "未找到 node，请安装 Node.js 20+"; exit 1; }
c_ok "node: $(node --version)"

if ! command -v pnpm >/dev/null 2>&1; then
  c_warn "未找到 pnpm，尝试启用 corepack"
  corepack enable >/dev/null 2>&1 || true
  corepack prepare pnpm@latest --activate >/dev/null 2>&1 || true
  command -v pnpm >/dev/null 2>&1 || { c_err "pnpm 不可用，请执行: npm i -g pnpm"; exit 1; }
fi
c_ok "pnpm: $(pnpm --version)"

# ---------- 2. 后端依赖 ----------
c_info "检查后端依赖"
NEED_INSTALL=0
[ "$MODE" = "reinstall" ] && NEED_INSTALL=1

if [ ! -x "$VENV_PY" ]; then
  c_warn "未找到虚拟环境，创建 backend/.venv"
  (cd "$BACKEND_DIR" && "$PY_BIN" -m venv .venv)
  NEED_INSTALL=1
fi

if [ "$NEED_INSTALL" = "1" ]; then
  c_info "安装后端依赖（requirements.txt）"
  (cd "$BACKEND_DIR" && "$VENV_PY" -m pip install -q --upgrade pip && "$VENV_PY" -m pip install -r requirements.txt)
  c_ok "后端依赖安装完成"
else
  if "$VENV_PY" -c "import fastapi, sqlalchemy, uvicorn" >/dev/null 2>&1; then
    c_ok "后端依赖已就绪"
  else
    c_warn "依赖不完整，自动安装"
    (cd "$BACKEND_DIR" && "$VENV_PY" -m pip install -r requirements.txt)
    c_ok "后端依赖安装完成"
  fi
fi

# ---------- 3. 前端依赖 ----------
c_info "检查前端依赖"
if [ "$NEED_INSTALL" = "1" ] || [ ! -d "$FRONTEND_DIR/node_modules" ]; then
  c_info "安装前端依赖（pnpm install，首次约 1-3 分钟）"
  (cd "$FRONTEND_DIR" && pnpm install)
  c_ok "前端依赖安装完成"
else
  c_ok "前端依赖已就绪"
fi

if [ "$MODE" = "check" ]; then
  echo ""
  echo "  ---- 环境检查结论 ----"
  if port_busy 8000; then c_warn "端口 8000 已被占用"; else c_ok "端口 8000 可用"; fi
  if port_busy 3000; then c_warn "端口 3000 已被占用"; else c_ok "端口 3000 可用"; fi
  c_ok "环境已就绪，执行 ./start.sh 即可启动"
  echo ""
  exit 0
fi

# ---------- 4. 启动 ----------
PIDS=()
cleanup() {
  echo ""
  c_info "正在停止服务..."
  for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done
  exit 0
}
trap cleanup INT TERM

if [ "$MODE" = "all" ] || [ "$MODE" = "backend" ] || [ "$MODE" = "reinstall" ]; then
  if port_busy 8000; then
    c_warn "端口 8000 已被占用，跳过后端启动"
  else
    c_info "启动后端 http://127.0.0.1:8000（同时监听局域网，供手机扫码访问）"
    (cd "$BACKEND_DIR" && exec "$VENV_PY" -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000) &
    PIDS+=($!)
  fi
fi

if [ "$MODE" = "all" ] || [ "$MODE" = "frontend" ] || [ "$MODE" = "reinstall" ]; then
  if port_busy 3000; then
    c_warn "端口 3000 已被占用，跳过前端启动"
  else
    c_info "启动前端 http://127.0.0.1:3000"
    (cd "$FRONTEND_DIR" && exec pnpm dev --port 3000) &
    PIDS+=($!)
  fi
fi

if [ "$MODE" = "all" ] || [ "$MODE" = "backend" ] || [ "$MODE" = "reinstall" ]; then
  c_info "等待后端就绪（最多 90 秒）"
  if wait_health "http://127.0.0.1:8000/health" 90; then c_ok "后端已就绪"; else c_warn "后端未在 90 秒内就绪"; fi
fi

echo ""
echo "  ---- 访问信息 ----"
echo "  老人端      http://127.0.0.1:3000/elder"
echo "  医护端      http://127.0.0.1:3000/staff"
echo "  API 文档    http://127.0.0.1:8000/docs"
echo "  健康检查    http://127.0.0.1:8000/health"
echo ""
echo "  想在手机上填：打开老人端，点右上角「用手机填写」，扫二维码即可。"
echo "  首次使用若手机打不开，请放行防火墙 3000 与 8000 端口。"
echo ""
echo "  ---- 演示账号 ----"
echo "  老人   elder   / elder12345"
echo "  医生   doctor  / doctor12345"
echo "  护士   nurse   / nurse12345"
echo "  管理   admin   / admin12345"
echo ""
echo "  按 Ctrl+C 停止服务。"
echo ""

wait
