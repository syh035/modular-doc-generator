import hashlib
from io import BytesIO
from pathlib import Path

import pymupdf
import pytest
from docx import Document
from fastapi.testclient import TestClient

from app.models.db import get_conn
from app.services.render_service import VersionRender


def frozen_scene(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> tuple[int, bytes, bytes]:
    doc = Document()
    doc.add_paragraph("原始内容")
    buffer = BytesIO()
    doc.save(buffer)
    data = buffer.getvalue()
    tpl = client.post("/api/templates", files={"file": ("归档.docx", data)}).json()
    pdf = tmp_path / "frozen.pdf"
    with pymupdf.open() as document:
        document.new_page().insert_text((72, 72), "Frozen")
        document.save(pdf)
    monkeypatch.setattr(
        "app.services.render_service.render_version",
        lambda version_id: VersionRender(data, pdf, []),
    )
    return tpl["default_version_id"], data, pdf.read_bytes()


def test_archive_survives_source_deletion_and_restart(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    vid, docx, pdf = frozen_scene(client, tmp_path, monkeypatch)
    response = client.post(f"/api/versions/{vid}/archives", json={"name": "投递定稿"})
    assert response.status_code == 201
    archive = response.json()
    with get_conn() as conn:
        conn.execute("DELETE FROM templates")
    assert client.get(f"/api/archives/{archive['id']}/docx").content == docx
    assert client.get(f"/api/archives/{archive['id']}/pdf").content == pdf
    assert archive["docx_sha256"] == hashlib.sha256(docx).hexdigest()
    from app.main import create_app

    with TestClient(create_app()) as restarted:
        assert restarted.get("/api/archives").json()["archives"] == [archive]
        assert restarted.delete(f"/api/archives/{archive['id']}").status_code == 204
        assert restarted.get(f"/api/archives/{archive['id']}/pdf").status_code == 404


def test_archive_overflow_confirmation_and_integrity(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    vid, data, _ = frozen_scene(client, tmp_path, monkeypatch)
    monkeypatch.setattr(
        "app.services.render_service.render_version",
        lambda version_id: VersionRender(
            data,
            tmp_path / "frozen.pdf",
            [{"id": 1, "label": "经历", "overflow": {"level": "large"}}],
        ),
    )
    url = f"/api/versions/{vid}/archives"
    assert client.post(url, json={"name": "定稿"}).status_code == 409
    assert client.get("/api/archives").json()["archives"] == []
    archive = client.post(url, json={"name": "定稿", "confirm_large_overflow": True}).json()
    with get_conn() as conn:
        conn.execute("UPDATE archives SET pdf=? WHERE id=?", (b"corrupt", archive["id"]))
    assert client.get(f"/api/archives/{archive['id']}/pdf").status_code == 409
    assert client.post(url, json={"name": " "}).status_code == 400
