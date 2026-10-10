"""本地简历编辑器后端入口。启动：uvicorn app.main:app（仅绑 127.0.0.1，P10）。"""

import re

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import RequestResponseEndpoint
from starlette.responses import Response

from app.api.blocks import router as blocks_router
from app.api.guide import router as guide_router
from app.api.health import router as health_router
from app.api.history import router as history_router
from app.api.migrations import router as migrations_router
from app.api.regions import router as regions_router
from app.api.tags import router as tags_router
from app.api.templates import router as templates_router
from app.api.versions import router as versions_router
from app.core.config import settings
from app.core.errors import AppError, app_error_handler, validation_error_handler
from app.models.db import get_conn, init_db
from app.services.history_service import HistoryJournal, capture
from app.services.template_service import upgrade_full_candidates, upgrade_pending_candidate_types


def create_app() -> FastAPI:
    settings.ensure_dirs()
    with get_conn() as conn:  # 建表幂等：启动即初始化 schema
        init_db(conn)
        upgrade_full_candidates(conn)
        upgrade_pending_candidate_types(conn)
    app = FastAPI(title="模块化文档生成助手 backend")
    app.state.history = HistoryJournal()

    @app.middleware("http")
    async def history_middleware(request: Request, call_next: RequestResponseEndpoint) -> Response:
        path = request.url.path
        mutating = request.method in {"POST", "PUT", "PATCH", "DELETE"}
        tracked = mutating and (
            path.startswith(("/api/blocks", "/api/tags", "/api/regions"))
            or (request.method == "PUT" and re.fullmatch(r"/api/versions/\d+", path) is not None)
            or "/bindings" in path
            or path.endswith(("/text", "/layout", "/migrate/apply"))
            or ("/templates/" in path and path.endswith("/regions"))
        )
        boundary = (
            mutating
            and not tracked
            and (
                path.startswith("/api/templates")
                or path.endswith("/export")
                or (
                    request.method == "DELETE"
                    and re.fullmatch(r"/api/versions/\d+", path) is not None
                )
            )
            and not path.endswith("/migrate/plan")
        )
        if not tracked and not boundary:
            return await call_next(request)
        history = app.state.history
        async with history.lock:
            with get_conn() as conn:
                before = capture(conn) if tracked else None
            response = await call_next(request)
            if response.status_code < 400:
                if boundary:
                    history.clear()
                elif before is not None:
                    with get_conn() as conn:
                        after = capture(conn)
                    label = (
                        "编辑文字"
                        if path.endswith("/text")
                        else "调整段落"
                        if path.endswith("/layout")
                        else "迁移绑定"
                        if path.endswith("/migrate/apply")
                        else "修改绑定"
                        if "/bindings" in path
                        else "管理字符块"
                        if path.startswith("/api/blocks")
                        else "管理标签"
                        if path.startswith("/api/tags")
                        else "区域校对"
                    )
                    history.record(label, before, after)
            return response

    app.include_router(history_router)
    app.include_router(health_router)
    app.include_router(templates_router)
    app.include_router(regions_router)
    app.include_router(blocks_router)
    app.include_router(tags_router)
    app.include_router(versions_router)
    app.include_router(migrations_router)
    app.include_router(guide_router)
    app.add_exception_handler(AppError, app_error_handler)  # type: ignore[arg-type]
    app.add_exception_handler(RequestValidationError, validation_error_handler)  # type: ignore[arg-type]
    if settings.static_dir is not None:
        app.mount("/", StaticFiles(directory=settings.static_dir, html=True), name="workbench")
    return app


app = create_app()
