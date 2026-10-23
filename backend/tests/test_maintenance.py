from pathlib import Path

import pytest
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


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("POST", "/api/maintenance/backup"),
        ("POST", "/api/maintenance/restore/inspect"),
        ("POST", "/api/maintenance/restore"),
        ("GET", "/api/maintenance/backups"),
        ("GET", "/api/maintenance/backups/before-restore-existing.zip"),
    ],
)
def test_removed_backup_routes_preserve_library_and_existing_files(
    client: TestClient, method: str, path: str
) -> None:
    backups = settings.db_path.parent / "backups"
    backups.mkdir()
    existing = backups / "before-restore-existing.zip"
    existing.write_bytes(b"previously saved backup")
    block = client.post("/api/blocks", json={"name": "保留素材", "content": "保留内容"})
    assert block.status_code == 201
    blocks_before = client.get("/api/blocks").json()

    response = client.request(
        method,
        path,
        files={"file": ("backup.zip", b"unused upload")},
        data={"confirm": "true", "expected_sha256": "unused"},
    )

    assert response.status_code == 404
    assert path not in client.get("/openapi.json").json()["paths"]
    assert client.get("/api/blocks").json() == blocks_before
    assert existing.read_bytes() == b"previously saved backup"
