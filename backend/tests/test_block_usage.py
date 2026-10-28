from io import BytesIO

from docx import Document
from fastapi.testclient import TestClient


def test_usage_and_version_copy_preserve_other_versions_and_options(client: TestClient) -> None:
    doc = Document()
    doc.add_paragraph("{{姓名}}")
    stream = BytesIO()
    doc.save(stream)
    tpl = client.post("/api/templates", files={"file": ("模板.docx", stream.getvalue())}).json()
    vid, rid = tpl["default_version_id"], tpl["regions"][0]["id"]
    block = client.post(
        "/api/blocks", json={"name": "姓名", "content": "张三", "tags": ["共享"]}
    ).json()
    client.post(
        f"/api/versions/{vid}/bindings",
        json={
            "block_id": block["id"],
            "region_id": rid,
            "position": "before",
            "line_break_mode": "soft",
        },
    )
    copied = client.post(
        f"/api/templates/{tpl['id']}/versions", json={"name": "副本", "copy_from": vid}
    ).json()
    usage = client.get(f"/api/blocks/{block['id']}/usage").json()
    assert {v["id"] for v in usage["versions"]} == {vid, copied["id"]}
    assert usage["templates"] == [{"id": tpl["id"], "filename": "模板.docx"}]
    result = client.post(f"/api/blocks/{block['id']}/versions/{vid}/copy", json={"content": "李四"})
    assert result.status_code == 201
    new = result.json()
    assert new["tags"][0]["name"] == "共享"
    assert client.get(f"/api/blocks/{block['id']}").json()["content"] == "张三"
    first = client.get(f"/api/versions/{vid}/bindings").json()["bindings"][0]
    other = client.get(f"/api/versions/{copied['id']}/bindings").json()["bindings"][0]
    assert first["block_id"] == new["id"] and other["block_id"] == block["id"]
    assert first["position"] == "before" and first["line_break_mode"] == "soft"
    assert client.post("/api/history/undo").status_code == 200
    assert (
        client.get(f"/api/versions/{vid}/bindings").json()["bindings"][0]["block_id"] == block["id"]
    )
    assert client.get(f"/api/blocks/{new['id']}").status_code == 404


def test_copy_of_unbound_or_deleted_block_is_rejected(client: TestClient) -> None:
    block = client.post("/api/blocks", json={"name": "独立", "content": "正文"}).json()
    url = f"/api/blocks/{block['id']}/versions/123/copy"
    assert client.post(url, json={"content": "新内容"}).status_code == 409
    assert len(client.get("/api/blocks").json()["blocks"]) == 1
    client.delete(f"/api/blocks/{block['id']}")
    assert client.get(f"/api/blocks/{block['id']}/usage").status_code == 404
    assert client.post(url, json={"content": "新内容"}).status_code == 404
