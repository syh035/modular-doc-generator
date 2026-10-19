import hashlib
import json
import os
import sqlite3
import zipfile
from io import BytesIO
from pathlib import Path

import pytest
from docx import Document
from fastapi.testclient import TestClient

from app.core.config import settings
from app.models.db import get_conn


def scene(client: TestClient) -> None:
    doc = Document()
    doc.add_paragraph("{{姓名}}")
    buffer = BytesIO()
    doc.save(buffer)
    template = client.post(
        "/api/templates", files={"file": ("备份模板.docx", buffer.getvalue())}
    ).json()
    block = client.post(
        "/api/blocks", json={"name": "姓名", "content": "张三", "tags": ["个人"]}
    ).json()
    client.post(
        f"/api/versions/{template['default_version_id']}/bindings",
        json={"region_id": template["regions"][0]["id"], "block_id": block["id"]},
    )
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO archives (name,source_version_id,version_name,template_name,created_at,"
            "docx,pdf,docx_sha256,pdf_sha256,source_json) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (
                "冻结",
                1,
                "原版",
                "模板",
                "2026-10-17",
                b"docx",
                b"pdf",
                hashlib.sha256(b"docx").hexdigest(),
                hashlib.sha256(b"pdf").hexdigest(),
                "{}",
            ),
        )


def restore(client: TestClient, data: bytes, confirm: bool = True) -> object:
    return client.post(
        "/api/maintenance/restore",
        files={"file": ("backup.zip", data)},
        data={"confirm": str(confirm).lower(), "expected_sha256": hashlib.sha256(data).hexdigest()},
    )


def test_round_trip_keeps_archive_and_creates_recovery_backup(client: TestClient) -> None:
    scene(client)
    backup = client.post("/api/maintenance/backup").content
    info = client.post("/api/maintenance/restore/inspect", files={"file": ("backup.zip", backup)})
    assert info.json()["counts"] == {"templates": 1, "versions": 1, "blocks": 1, "archives": 1}
    client.put("/api/blocks/1", json={"content": "后来内容"})
    rejected = client.post(
        "/api/maintenance/restore",
        files={"file": ("backup.zip", backup)},
        data={"expected_sha256": info.json()["sha256"]},
    )
    assert rejected.status_code == 409
    response = client.post(
        "/api/maintenance/restore",
        files={"file": ("backup.zip", backup)},
        data={"confirm": "true", "expected_sha256": info.json()["sha256"]},
    )
    assert response.status_code == 200, response.text
    assert client.get("/api/blocks/1").json()["content"] == "张三"
    assert client.get("/api/archives/1/pdf").content == b"pdf"
    assert client.get("/api/history/status").json()["undo_count"] == 0
    recovery = client.get(f"/api/maintenance/backups/{response.json()['backup_name']}").content
    response = client.post(
        "/api/maintenance/restore",
        files={"file": ("backup.zip", recovery)},
        data={"confirm": "true", "expected_sha256": hashlib.sha256(recovery).hexdigest()},
    )
    assert response.status_code == 200
    assert client.get("/api/blocks/1").json()["content"] == "后来内容"


def test_invalid_backup_and_paths_never_replace_current_library(client: TestClient) -> None:
    scene(client)
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("../outside", "bad")
    for data in (b"not a zip", buffer.getvalue()):
        response = client.post(
            "/api/maintenance/restore/inspect", files={"file": ("bad.zip", data)}
        )
        assert response.status_code == 400
        assert client.get("/api/blocks/1").json()["content"] == "张三"


def test_valid_sqlite_with_wrong_application_schema_is_rejected(
    client: TestClient, tmp_path: Path
) -> None:
    scene(client)
    data = client.post("/api/maintenance/backup").content
    with zipfile.ZipFile(BytesIO(data)) as original:
        files = {name: original.read(name) for name in original.namelist()}
    database = tmp_path / "wrong-schema.db"
    database.write_bytes(files["app.db"])
    with sqlite3.connect(database) as conn:
        conn.execute("ALTER TABLE blocks RENAME COLUMN content TO wrong_content")
    conn.close()  # Flush WAL before putting the changed database bytes back into the ZIP.
    files["app.db"] = database.read_bytes()
    manifest = json.loads(files["manifest.json"])
    manifest["files"]["app.db"] = hashlib.sha256(files["app.db"]).hexdigest()
    files["manifest.json"] = json.dumps(manifest).encode()
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w") as modified:
        for name, content in files.items():
            modified.writestr(name, content)
    response = client.post(
        "/api/maintenance/restore/inspect", files={"file": ("wrong.zip", buffer.getvalue())}
    )
    assert response.status_code == 400
    assert client.get("/api/blocks/1").json()["content"] == "张三"


def test_restore_rolls_back_file_install_failure(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    scene(client)
    backup = client.post("/api/maintenance/backup").content
    client.put("/api/blocks/1", json={"content": "保留此内容"})
    original_replace = os.replace
    failed = False

    def fail_once(source: str | Path, destination: str | Path) -> None:
        nonlocal failed
        if Path(source).parent.name == "new" and Path(source).name == "templates" and not failed:
            failed = True
            raise OSError("simulated disk failure")
        original_replace(source, destination)

    monkeypatch.setattr("app.services.backup_service.os.replace", fail_once)
    response = client.post(
        "/api/maintenance/restore",
        files={"file": ("backup.zip", backup)},
        data={"confirm": "true", "expected_sha256": hashlib.sha256(backup).hexdigest()},
    )
    assert response.status_code == 500
    assert client.get("/api/blocks/1").json()["content"] == "保留此内容"
    assert len(list(settings.templates_dir.iterdir())) == 1
    assert client.get("/api/maintenance/backups").json()["backups"]
