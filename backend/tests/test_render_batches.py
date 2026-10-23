from pathlib import Path

import pymupdf
import pytest
from fastapi.testclient import TestClient

from app.services import render_service, render_sessions


def test_overlay_reads_the_exact_downloaded_pdf_without_rerendering(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    pdf = tmp_path / "batch.pdf"
    with pymupdf.open() as document:
        document.new_page().insert_text((72, 72), "Original")
        document.save(pdf)
    calls = []

    def render(version_id: int) -> render_service.VersionRender:
        calls.append(version_id)
        return render_service.VersionRender(b"docx", pdf, [{"id": 1, "current_text": "原内容"}])

    monkeypatch.setattr(render_service, "render_version", render)
    response = client.get("/api/versions/8/preview")
    token = response.headers["x-render-token"]
    monkeypatch.setattr(
        render_service,
        "render_version",
        lambda version_id: (_ for _ in ()).throw(AssertionError("Overlay must not render again")),
    )
    overlay = client.get(f"/api/versions/8/overlay?render_token={token}")
    assert overlay.status_code == 200
    assert overlay.json()["regions"][0]["current_text"] == "原内容"
    import hashlib

    assert overlay.json()["pdf_sha256"] == hashlib.sha256(response.content).hexdigest()
    assert calls == [8]
    assert client.get(f"/api/versions/9/overlay?render_token={token}").status_code == 409
    render_sessions.clear()
    assert client.get(f"/api/versions/8/overlay?render_token={token}").status_code == 409


def test_recent_render_reuses_geometry_and_invalidates_on_edit(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from io import BytesIO
    from types import SimpleNamespace

    from docx import Document

    document = Document()
    document.add_paragraph("原内容")
    stream = BytesIO()
    document.save(stream)
    template = client.post(
        "/api/templates", files={"file": ("模板.docx", stream.getvalue())}
    ).json()
    pdf = tmp_path / "render.pdf"
    with pymupdf.open() as source:
        source.new_page().insert_text((72, 72), "Original")
        source.save(pdf)
    conversions = []

    def convert(path: Path) -> Path:
        conversions.append(path)
        return pdf

    monkeypatch.setattr("app.services.libreoffice._manager", SimpleNamespace(convert=convert))
    version = template["default_version_id"]
    first = render_service.render_version(version)
    second = render_service.render_version(version)
    assert first.pdf_data == second.pdf_data and len(conversions) == 1
    second.items.clear()
    assert render_service.render_version(version).items
    region = template["regions"][0]["id"]
    client.patch(f"/api/regions/{region}", json={"label": "新标题"})
    assert render_service.render_version(version).items[0]["label"] == "新标题"
    assert len(conversions) == 2
