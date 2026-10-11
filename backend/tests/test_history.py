"""Journal recovery is atomic, bounded and guarded against out-of-band edits."""

from io import BytesIO

from docx import Document
from fastapi.testclient import TestClient

from app.models.db import get_conn


def make_scene(client: TestClient) -> dict:
    doc = Document()
    doc.add_paragraph("{{姓名}}")
    buf = BytesIO()
    doc.save(buf)
    tpl = client.post("/api/templates", files={"file": ("撤销.docx", buf.getvalue())}).json()
    client.post("/api/history/clear")
    return tpl


def test_undo_redo_block_binding_layout_and_soft_delete(client: TestClient) -> None:
    tpl = make_scene(client)
    vid, rid = tpl["default_version_id"], tpl["regions"][0]["id"]
    block = client.post(
        "/api/blocks", json={"name": "测试内容", "content": "内容", "tags": ["标签"]}
    ).json()
    assert (
        client.post(
            f"/api/versions/{vid}/bindings",
            json={
                "region_id": rid,
                "block_id": block["id"],
                "position": "before",
                "line_break_mode": "soft",
            },
        ).status_code
        == 200
    )
    client.post(f"/api/versions/{vid}/regions/{rid}/layout", json={"action": "remove"})
    client.delete(f"/api/blocks/{block['id']}")
    assert client.get("/api/history/status").json()["undo_count"] == 4
    assert client.post("/api/history/undo").status_code == 200
    assert client.get(f"/api/blocks/{block['id']}").json()["tags"][0]["name"] == "标签"
    binding = client.get(f"/api/versions/{vid}/bindings").json()["bindings"][0]
    assert (
        binding["status"] == "active"
        and binding["position"] == "before"
        and binding["line_break_mode"] == "soft"
    )
    client.post("/api/history/undo")
    with get_conn() as conn:
        assert conn.execute("SELECT COUNT(*) FROM version_region_actions").fetchone()[0] == 0
    client.post("/api/history/undo")
    assert client.get(f"/api/versions/{vid}/bindings").json()["bindings"] == []
    client.post("/api/history/undo")
    assert client.get("/api/blocks").json()["blocks"] == []
    for _ in range(4):
        assert client.post("/api/history/redo").status_code == 200
    assert client.get("/api/blocks").json()["blocks"] == []
    assert client.get(f"/api/versions/{vid}/bindings").json()["bindings"][0]["status"] == "missing"


def test_noop_failed_operation_redo_branch_and_bound(client: TestClient) -> None:
    make_scene(client)
    block = client.post("/api/blocks", json={"name": "初始", "content": "内容"}).json()
    bid = block["id"]
    client.put(f"/api/blocks/{bid}", json={"content": "内容"})
    client.put(f"/api/blocks/{bid}", json={"content": ""})
    assert client.get("/api/history/status").json()["undo_count"] == 1
    for i in range(55):
        assert client.put(f"/api/blocks/{bid}", json={"name": f"名称{i}"}).status_code == 200
    assert client.get("/api/history/status").json()["undo_count"] == 50
    client.post("/api/history/undo")
    assert client.get("/api/history/status").json()["redo_count"] == 1
    client.put(f"/api/blocks/{bid}", json={"name": "新分支"})
    assert client.get("/api/history/status").json()["redo_count"] == 0


def test_conflict_and_derived_bbox_manual_preservation(client: TestClient) -> None:
    tpl = make_scene(client)
    rid = tpl["regions"][0]["id"]
    client.patch(f"/api/regions/{rid}", json={"review_status": "confirmed"})
    with get_conn() as conn:
        conn.execute(
            "UPDATE regions SET bbox_json=?, bbox_pdf_sha='derived' WHERE id=?", ('{"page":0}', rid)
        )
    assert client.post("/api/history/undo").status_code == 200
    assert (
        client.get(f"/api/templates/{tpl['id']}").json()["regions"][0]["review_status"] == "pending"
    )
    client.post("/api/history/redo")
    with get_conn() as conn:
        conn.execute("UPDATE regions SET label='其他窗口修改' WHERE id=?", (rid,))
    response = client.post("/api/history/undo")
    assert response.status_code == 409 and response.json()["error"]["code"] == "HISTORY_CONFLICT"
    assert client.get("/api/history/status").json()["undo_count"] == 1
    assert client.post("/api/history/clear").json()["undo_count"] == 0


def test_region_delete_restore_identity_and_binding(client: TestClient) -> None:
    tpl = make_scene(client)
    vid, rid = tpl["default_version_id"], tpl["regions"][0]["id"]
    block = client.post("/api/blocks", json={"name": "测试", "content": "内容"}).json()
    client.post(f"/api/versions/{vid}/bindings", json={"region_id": rid, "block_id": block["id"]})
    client.post("/api/history/clear")
    client.delete(f"/api/regions/{rid}")
    assert client.post("/api/history/undo").status_code == 200
    assert client.get(f"/api/templates/{tpl['id']}").json()["regions"][0]["id"] == rid
    assert (
        client.get(f"/api/versions/{vid}/bindings").json()["bindings"][0]["block_id"] == block["id"]
    )


def test_text_edit_atomic_manual_frame_and_export_boundary(client: TestClient) -> None:
    tpl = make_scene(client)
    vid, rid = tpl["default_version_id"], tpl["regions"][0]["id"]
    with get_conn() as conn:
        conn.execute(
            "UPDATE regions SET bbox_source='manual', bbox_json=?, "
            "bbox_pdf_sha='manual-source' WHERE id=?",
            ('{"page":0,"x0":10,"y0":10,"x1":100,"y1":30}', rid),
        )
    response = client.post(
        f"/api/versions/{vid}/regions/{rid}/text", json={"content": "版本编辑内容"}
    )
    assert response.status_code == 200
    assert client.get("/api/history/status").json()["undo_count"] == 1
    client.post("/api/history/undo")
    assert client.get("/api/blocks").json()["blocks"] == []
    assert client.get(f"/api/versions/{vid}/bindings").json()["bindings"] == []
    with get_conn() as conn:
        row = conn.execute(
            "SELECT bbox_source,bbox_pdf_sha,bbox_json FROM regions WHERE id=?", (rid,)
        ).fetchone()
        assert row["bbox_source"] == "manual" and row["bbox_pdf_sha"] == "manual-source"
        assert '"x0":10' in row["bbox_json"]
    client.post("/api/history/redo")
    response = client.post(f"/api/versions/{vid}/export", json={"confirm_large_overflow": True})
    assert response.status_code == 200
    assert client.get("/api/history/status").json()["undo_count"] == 0
