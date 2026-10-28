"""试排复用真实 LO 管线，业务库／历史只读，坐标与 PDF 同批。"""

import base64
import hashlib

import pymupdf
import pytest

from app.models.db import get_conn
from app.services import render_service
from app.services.history_service import capture
from tests.test_document_migration import apply, payload, prepare
from tests.test_migration import scene as scene


def test_trial_is_read_only_and_matches_generated_document(scene: dict) -> None:
    s, t, _ = prepare(scene)
    client = scene["client"]
    body = payload(scene, s, t)
    with get_conn() as conn:
        before = capture(conn)
    history = client.get("/api/history/status").json()
    response = client.post(f"/api/templates/{scene['dst']['id']}/migrate/preview", json=body)
    assert response.status_code == 200, response.text
    trial = response.json()
    pdf = base64.b64decode(trial["pdf_base64"])
    assert hashlib.sha256(pdf).hexdigest() == trial["pdf_sha256"]
    assert trial["plan_token"] == body["plan_token"]
    with pymupdf.open(stream=pdf, filetype="pdf") as doc:
        assert "内容" in "".join(page.get_text() for page in doc)
    target = next(item for item in trial["items"] if item["id"] == t)
    assert target["bbox"] is not None
    assert target["current_text"] == "内容"
    assert client.get("/api/history/status").json() == history
    with get_conn() as conn:
        assert capture(conn) == before
        assert conn.execute("SELECT COUNT(*) FROM migration_receipts").fetchone()[0] == 0
    created = apply(scene, body)
    assert created.status_code == 201
    rendered = render_service.render_version(created.json()["version_id"])
    assert rendered.pdf_data == pdf
    assert next(item for item in rendered.items if item["id"] == t)["bbox"] == target["bbox"]


@pytest.mark.parametrize("case", ["stale", "foreign", "duplicate", "unknown", "partial"])
def test_trial_validates_without_creating(
    scene: dict, case: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    s, t, _ = prepare(scene)
    body = payload(scene, s, t)
    if case == "stale":
        body["plan_token"] = "old"
    elif case == "foreign":
        body["placements"][0]["target_region_id"] = s
    elif case == "duplicate":
        body["placements"] *= 2
    elif case == "unknown":
        body["omitted_source_region_ids"] = [9999]
    else:
        body["placements"] = []

    class FakeRender:
        pdf_data = b"PDF"
        items: list[dict[str, object]] = []

    monkeypatch.setattr(render_service, "render_document", lambda *a, **k: FakeRender())
    response = scene["client"].post(
        f"/api/templates/{scene['dst']['id']}/migrate/preview", json=body
    )
    assert response.status_code == (200 if case == "partial" else 409 if case == "stale" else 400)
    with get_conn() as conn:
        assert conn.execute("SELECT COUNT(*) FROM versions").fetchone()[0] == 2
