"""Local library maintenance; cached previews are disposable, source documents are not."""

from fastapi import APIRouter

from app.core.config import settings
from app.services.libreoffice import LibreOfficeManager

router = APIRouter(prefix="/api/maintenance")


def get_manager() -> LibreOfficeManager:
    # Cache management must remain available even if LibreOffice is missing.
    return LibreOfficeManager(
        "",
        profile_dir=settings.lo_profile_dir,
        cache_dir=settings.render_cache_dir,
        timeout_seconds=30,
    )


@router.get("/cache")
def cache_status() -> dict[str, int]:
    return get_manager().cache_status()


@router.delete("/cache")
def clear_cache() -> dict[str, int]:
    return get_manager().clear_cache()
