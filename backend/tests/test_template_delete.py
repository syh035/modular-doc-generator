"""模板删除保护、级联、原件清理与失败回滚（不依赖 LO）。"""

import sqlite3
from collections.abc import Iterator
from io import BytesIO
from pathlib import Path

import pytest
from docx import Document
from fastapi.testclient import TestClient

from app.models.db import get_conn


def upload(client: TestClient) -> dict:
    doc = Document()
    doc.add_paragraph("{{姓名}}")
    buf = BytesIO()
    doc.save(buf)
    response = client.post("/api/templates", files={"file": ("删除测试.docx", buf.getvalue())})
    assert response.status_code == 201
    return response.json()


def bind(client: TestClient, template: dict) -> int:
    block = client.post("/api/blocks", json={"name": "姓名", "content": "张三"}).json()
    response = client.post(
        f"/api/versions/{template['default_version_id']}/bindings",
        json={"region_id": template["regions"][0]["id"], "block_id": block["id"]},
    )
    assert response.status_code == 200
    return block["id"]


def test_delete_active_binding_protected(client: TestClient, tmp_path: Path) -> None:
    template = upload(client)
    bind(client, template)
    response = client.delete(f"/api/templates/{template['id']}")
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "TEMPLATE_IN_USE"
    assert client.get(f"/api/templates/{template['id']}").status_code == 200
    assert (tmp_path / "templates" / template["storage_name"]).exists()


def test_delete_cascades_missing_bindings_and_all_versions(
    client: TestClient,
    tmp_path: Path,
) -> None:
    template = upload(client)
    block_id = bind(client, template)
    response = client.post(
        f"/api/templates/{template['id']}/versions",
        json={"name": "副本", "copy_from": template["default_version_id"]},
    )
    assert response.status_code == 201
    assert client.delete(f"/api/blocks/{block_id}").status_code == 204
    assert client.delete(f"/api/templates/{template['id']}").status_code == 204
    assert not (tmp_path / "templates" / template["storage_name"]).exists()
    assert not list((tmp_path / "templates").glob(".delete-*"))
    with get_conn() as conn:
        for table in ("templates", "versions", "regions", "bindings"):
            assert conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 0
        assert conn.execute("SELECT deleted_at FROM blocks WHERE id = ?", (block_id,)).fetchone()[0]
    assert client.delete(f"/api/templates/{template['id']}").status_code == 404


def test_delete_file_error_rolls_back(
    client: TestClient,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    template = upload(client)
    original = tmp_path / "templates" / template["storage_name"]

    def denied(self: Path, target: Path) -> Path:
        raise PermissionError("denied")

    monkeypatch.setattr(Path, "rename", denied)
    response = client.delete(f"/api/templates/{template['id']}")
    assert response.status_code == 500
    assert response.json()["error"]["code"] == "TEMPLATE_DELETE_FAILED"
    assert original.exists()
    assert client.get(f"/api/templates/{template['id']}").status_code == 200
    with get_conn() as conn:
        assert conn.execute("SELECT COUNT(*) FROM versions").fetchone()[0] == 1


def test_delete_missing_original_and_reimport(client: TestClient, tmp_path: Path) -> None:
    template = upload(client)
    (tmp_path / "templates" / template["storage_name"]).unlink()
    assert client.delete(f"/api/templates/{template['id']}").status_code == 204
    next_template = upload(client)
    assert next_template["id"] != template["id"]
    assert next_template["reused"] is False


def test_delete_commit_error_restores_original(
    client: TestClient,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from contextlib import contextmanager

    from app.services import template_service

    template = upload(client)
    original = tmp_path / "templates" / template["storage_name"]

    @contextmanager
    def failing_commit() -> Iterator[sqlite3.Connection]:
        with get_conn() as conn:
            yield conn
            raise RuntimeError("commit failed")

    monkeypatch.setattr(template_service, "get_conn", failing_commit)
    with pytest.raises(RuntimeError, match="commit failed"):
        client.delete(f"/api/templates/{template['id']}")
    assert original.exists()
    assert client.get(f"/api/templates/{template['id']}").status_code == 200
    assert not list((tmp_path / "templates").glob(".delete-*"))
