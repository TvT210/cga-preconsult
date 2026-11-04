"""FastAPI 应用入口。

启动：`python -m uvicorn app.main:app --reload --port 8000`（在 backend/ 目录下执行）
"""

from __future__ import annotations

import json
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response

from app.api import EnvelopeRoute, admin, assessments, auth, dialogue, matching, patients, reports, scales
from app.core.config import settings
from app.db.init_db import init_db


@asynccontextmanager
async def lifespan(app: FastAPI):
    """启动时建表并播种（幂等）。"""
    init_db(seed=True)
    yield


app = FastAPI(
    title=settings.app_name,
    version="0.1.0",
    description="老年人就医前预问诊与老年综合评估系统 API（依据 WS/T 888—2026 附录 B）",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in settings.cors_origins.split(",") if origin.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    return JSONResponse(status_code=exc.status_code, content={"code": exc.status_code, "message": str(exc.detail), "data": None})


@app.get("/health")
def health():
    return {"status": "ok", "app": settings.app_name, "version": "0.1.0"}


# FastAPI 0.16x 的 include_router 不会传递子路由的自定义 route_class，
# 这里用中间件统一封装响应信封 {code, message, data}，与版本无关。
app.router.route_class = EnvelopeRoute


@app.middleware("http")
async def envelope_middleware(request: Request, call_next):
    response = await call_next(request)
    path = request.url.path
    if not path.startswith(settings.api_prefix) or response.status_code != 200:
        return response
    media_type = response.headers.get("content-type", "")
    if not media_type.startswith("application/json"):
        return response
    body = b"".join([chunk async for chunk in response.body_iterator])
    try:
        payload = json.loads(body)
    except ValueError:
        return Response(content=body, status_code=response.status_code, media_type=media_type)
    if isinstance(payload, dict) and "code" in payload and "data" in payload:
        return JSONResponse(status_code=response.status_code, content=payload, headers=headers)
    payload = {"code": 0, "message": "ok", "data": payload}
    headers = {key: value for key, value in response.headers.items() if key.lower() != "content-length"}
    return JSONResponse(status_code=response.status_code, content=payload, headers=headers)


for module in (auth, patients, scales, assessments, reports, matching, dialogue, admin):
    app.include_router(module.router, prefix=settings.api_prefix)


@app.get("/")
def index():
    return {
        "app": settings.app_name,
        "api_prefix": settings.api_prefix,
        "docs": "/docs",
        "health": "/health",
    }
