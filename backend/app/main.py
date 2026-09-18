"""本地简历编辑器后端入口。启动：uvicorn app.main:app（仅绑 127.0.0.1，P10）。"""

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError

from app.api.blocks import router as blocks_router
from app.api.guide import router as guide_router
from app.api.health import router as health_router
from app.api.tags import router as tags_router
from app.api.templates import router as templates_router
from app.api.versions import router as versions_router
from app.core.config import settings
from app.core.errors import AppError, app_error_handler, validation_error_handler
from app.models.db import get_conn, init_db


def create_app() -> FastAPI:
    settings.ensure_dirs()
    with get_conn() as conn:  # 建表幂等：启动即初始化 schema
        init_db(conn)
    app = FastAPI(title="简历助手 backend")
    app.include_router(health_router)
    app.include_router(templates_router)
    app.include_router(blocks_router)
    app.include_router(tags_router)
    app.include_router(versions_router)
    app.include_router(guide_router)
    app.add_exception_handler(AppError, app_error_handler)  # type: ignore[arg-type]
    app.add_exception_handler(RequestValidationError, validation_error_handler)  # type: ignore[arg-type]
    return app


app = create_app()
