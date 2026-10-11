"""API 入口：/api/health。"""

import hashlib

from fastapi import APIRouter

from app.core.config import settings
from app.services.libreoffice import check_libreoffice

router = APIRouter(prefix="/api")


@router.get("/health")
def health() -> dict[str, object]:
    """服务健康检查：进程存活 + LibreOffice 依赖状态（D2）。"""
    return {
        "status": "ok",
        "libreoffice": check_libreoffice(),
        "application": "modular-doc-generator",
        "data_fingerprint": hashlib.sha256(str(settings.data_dir.resolve()).encode()).hexdigest(),
        "project_fingerprint": hashlib.sha256(
            str(settings.project_root.resolve()).encode()
        ).hexdigest(),
    }


@router.post("/environment/check")
def verify_environment() -> dict[str, object]:
    """Packaged startup acceptance uses the same real document conversion pipeline."""
    from app.services.libreoffice import get_manager
    from app.services.sample_template import build_sample_docx

    manager = get_manager()
    import tempfile
    from pathlib import Path

    with tempfile.TemporaryDirectory(prefix="modudoc-environment-") as directory:
        sample = Path(directory) / "sample.docx"
        sample.write_bytes(build_sample_docx())
        pdf = manager.convert(sample)
        return {"conversion_ready": pdf.is_file() and pdf.stat().st_size > 0}
