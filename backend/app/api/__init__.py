"""API 路由公共封装：统一响应信封 {code, message, data}。

每个模块应通过 `new_router()` 创建自己的路由实例，避免多模块共用同一实例
导致路由被重复注册。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from starlette.responses import Response


class EnvelopeRoute(APIRoute):
    """把处理函数的返回值包装成统一响应信封。"""

    def get_route_handler(self):  # type: ignore[override]
        original = super().get_route_handler()

        async def custom_handler(request: Request) -> Any:
            response = await original(request)
            if isinstance(response, Response):  # 文件下载等直接返回的响应原样透传
                return response
            return JSONResponse(status_code=200, content={"code": 0, "message": "ok", "data": response})

        return custom_handler


def new_router() -> APIRouter:
    return APIRouter(route_class=EnvelopeRoute)


def paginate(items: list[Any], page: int = 1, size: int = 20) -> dict[str, Any]:
    start = max(page - 1, 0) * size
    return {"items": items[start : start + size], "total": len(items), "page": page, "size": size}
