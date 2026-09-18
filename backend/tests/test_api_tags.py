"""/api/tags 测试（M2）：列表计数、重命名全库生效、撞名即合并、删除。"""

from fastapi.testclient import TestClient


def create_block_with_tags(client: TestClient, name: str, tags: list[str]) -> dict:
    resp = client.post("/api/blocks", json={"name": name, "content": f"{name}内容", "tags": tags})
    assert resp.status_code == 201
    return resp.json()


def test_list_tags_empty(client: TestClient) -> None:
    resp = client.get("/api/tags")
    assert resp.status_code == 200
    assert resp.json() == {"tags": []}


def test_list_tags_with_counts(client: TestClient) -> None:
    create_block_with_tags(client, "块甲", ["求职", "姓名"])
    create_block_with_tags(client, "块乙", ["求职"])
    body = client.get("/api/tags").json()["tags"]
    assert [(t["name"], t["block_count"]) for t in body] == [("姓名", 1), ("求职", 2)]  # 按名称排序


def test_rename_tag_applies_library_wide(client: TestClient) -> None:
    b = create_block_with_tags(client, "块甲", ["求职"])
    tag_id = b["tags"][0]["id"]
    resp = client.put(f"/api/tags/{tag_id}", json={"name": "找工作"})
    assert resp.status_code == 200
    assert resp.json()["name"] == "找工作"
    # 全库生效：块上的标签名随之更新
    detail = client.get(f"/api/blocks/{b['id']}").json()
    assert detail["tags"][0]["name"] == "找工作"


def test_rename_to_existing_name_merges(client: TestClient) -> None:
    b1 = create_block_with_tags(client, "块甲", ["求职"])
    b2 = create_block_with_tags(client, "块乙", ["找工作"])
    source_id = b1["tags"][0]["id"]
    target_id = b2["tags"][0]["id"]
    resp = client.put(f"/api/tags/{source_id}", json={"name": "找工作"})  # 撞名 → 合并
    assert resp.status_code == 200
    assert resp.json()["id"] == target_id
    tags = {t["name"]: t["block_count"] for t in client.get("/api/tags").json()["tags"]}
    assert "求职" not in tags  # 源标签已删除
    assert tags["找工作"] == 2  # 两块的关联并入目标
    assert client.get(f"/api/blocks/{b1['id']}").json()["tags"][0]["id"] == target_id


def test_rename_same_name_idempotent(client: TestClient) -> None:
    b = create_block_with_tags(client, "块甲", ["求职"])
    tag_id = b["tags"][0]["id"]
    resp = client.put(f"/api/tags/{tag_id}", json={"name": " 求职 "})
    assert resp.status_code == 200
    assert resp.json()["id"] == tag_id


def test_rename_tag_not_found(client: TestClient) -> None:
    resp = client.put("/api/tags/999", json={"name": "新名"})
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "TAG_NOT_FOUND"


def test_rename_tag_invalid_name(client: TestClient) -> None:
    b = create_block_with_tags(client, "块甲", ["求职"])
    tag_id = b["tags"][0]["id"]
    for bad in ("", "   ", "超" * 21):
        resp = client.put(f"/api/tags/{tag_id}", json={"name": bad})
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "TAG_INVALID"


def test_delete_tag(client: TestClient) -> None:
    b = create_block_with_tags(client, "块甲", ["求职", "姓名"])
    tag_id = next(t["id"] for t in b["tags"] if t["name"] == "求职")
    resp = client.delete(f"/api/tags/{tag_id}")
    assert resp.status_code == 204
    tags = {t["name"] for t in client.get("/api/tags").json()["tags"]}
    assert "求职" not in tags and "姓名" in tags
    # 块本身不受影响，仅摘除该标签
    detail = client.get(f"/api/blocks/{b['id']}").json()
    assert [t["name"] for t in detail["tags"]] == ["姓名"]
    assert client.delete(f"/api/tags/{tag_id}").status_code == 404  # 幂等拒绝
