"""本地简历编辑器后端入口。启动：uvicorn app.main:app（仅绑 127.0.0.1，P10）。"""

from fastapi import FastAPI

from app.api.health import router as health_router
from app.core.config import settings
from app.core.errors import AppError, app_error_handler


def create_app() -> FastAPI:
    settings.ensure_dirs()
    app = FastAPI(title="简历助手 backend")
    app.include_router(health_router)
    app.add_exception_handler(AppError, app_error_handler)  # type: ignore[arg-type]
    return app


app = create_app()
