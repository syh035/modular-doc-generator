from pathlib import Path

from fastapi.testclient import TestClient

from app.core.config import settings


def test_clear_cache_preserves_documents(client: TestClient) -> None:
    cached = settings.render_cache_dir / "old.pdf"
    cached.write_bytes(b"cached")
    original = settings.templates_dir / "original.docx"
    original.write_bytes(b"document")
    assert client.get("/api/maintenance/cache").json()["bytes"] == 6
    assert client.delete("/api/maintenance/cache").json()["files"] == 0
    assert original.read_bytes() == b"document"
    assert not Path(cached).exists()
