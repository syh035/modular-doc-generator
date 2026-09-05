"""API 入口：/api/health。"""

from fastapi import APIRouter

from app.services.libreoffice import check_libreoffice

router = APIRouter(prefix="/api")


@router.get("/health")
def health() -> dict[str, object]:
    """服务健康检查：进程存活 + LibreOffice 依赖状态（D2）。"""
    return {"status": "ok", "libreoffice": check_libreoffice()}
