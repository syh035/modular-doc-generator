"""/api/blocks 测试（M6a 最小块 API）：创建 201、字段校验 400、列表。"""

from fastapi.testclient import TestClient


def create_block(
    client: TestClient,
    name: str,
    content: str,
    category: str = "未分类",
    tags: list[str] | None = None,
):
    payload: dict = {"name": name, "content": content, "category": category}
    if tags is not None:
        payload["tags"] = tags
    return client.post("/api/blocks", json=payload)


def test_create_block_201(client: TestClient) -> None:
    resp = create_block(client, "姓名", "张三", "基本信息")
    assert resp.status_code == 201
    body = resp.json()
    assert body["name"] == "姓名"
    assert body["content"] == "张三"
    assert body["category"] == "基本信息"
    assert body["id"] > 0


def test_create_block_name_stripped_and_default_category(client: TestClient) -> None:
    body = create_block(client, "  电话  ", "138").json()
    assert body["name"] == "电话"
    assert body["category"] == "未分类"  # 缺省分类


def test_create_block_name_too_short(client: TestClient) -> None:
    resp = create_block(client, "名", "内容")
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "BLOCK_INVALID"


def test_create_block_name_too_long(client: TestClient) -> None:
    resp = create_block(client, "长" * 31, "内容")
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "BLOCK_INVALID"


def test_create_block_content_over_limit(client: TestClient) -> None:
    resp = create_block(client, "超长块", "字" * 5001)
    assert resp.status_code == 400
    assert "5000" in resp.json()["error"]["message"]


def test_create_block_content_blank(client: TestClient) -> None:
    resp = create_block(client, "空块", "   \n  ")
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "BLOCK_INVALID"


def test_list_blocks(client: TestClient) -> None:
    create_block(client, "块A", "内容A")
    create_block(client, "块B", "内容B")
    resp = client.get("/api/blocks")
    assert resp.status_code == 200
    items = resp.json()["blocks"]
    assert [b["name"] for b in items] == ["块A", "块B"]  # 创建正序


# ---- M2：标签挂接 / 详情 / 更新 / 软删除 ----


def test_create_block_with_tags_and_list_back(client: TestClient) -> None:
    body = create_block(client, "姓名", "张三", tags=["求职", "基本信息"]).json()
    assert {t["name"] for t in body["tags"]} == {"求职", "基本信息"}  # 返回按名称排序
    items = client.get("/api/blocks").json()["blocks"]
    assert items[0]["tags"][0]["name"] == "基本信息"


def test_create_block_tags_get_or_create_shared(client: TestClient) -> None:
    b1 = create_block(client, "块甲", "内容", tags=["求职"]).json()
    b2 = create_block(client, "块乙", "内容", tags=["求职"]).json()
    assert b1["tags"][0]["id"] == b2["tags"][0]["id"]  # 同名共享一个标签


def test_create_block_tag_over_limit(client: TestClient) -> None:
    resp = create_block(client, "块甲", "内容", tags=[f"标签{i}" for i in range(11)])
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "TAG_INVALID"


def test_create_block_tag_name_too_long(client: TestClient) -> None:
    resp = create_block(client, "块甲", "内容", tags=["超" * 21])
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "TAG_INVALID"


def test_get_block_detail_404(client: TestClient) -> None:
    assert client.get("/api/blocks/999").status_code == 404
    assert client.get("/api/blocks/999").json()["error"]["code"] == "BLOCK_NOT_FOUND"


def test_update_block_partial(client: TestClient) -> None:
    block_id = create_block(client, "姓名", "张三", "基本信息", tags=["求职"]).json()["id"]
    resp = client.put(f"/api/blocks/{block_id}", json={"content": "李四"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["content"] == "李四"
    assert body["name"] == "姓名"  # 未传字段保持
    assert body["category"] == "基本信息"
    assert [t["name"] for t in body["tags"]] == ["求职"]  # tags 未传不动


def test_update_block_full_validation(client: TestClient) -> None:
    block_id = create_block(client, "姓名", "张三").json()["id"]
    resp = client.put(f"/api/blocks/{block_id}", json={"name": "名"})  # 与现内容组合校验
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "BLOCK_INVALID"


def test_update_block_replace_tags(client: TestClient) -> None:
    block_id = create_block(client, "姓名", "张三", tags=["求职", "旧标签"]).json()["id"]
    resp = client.put(f"/api/blocks/{block_id}", json={"tags": ["求职", "新标签"]})
    assert resp.status_code == 200
    assert {t["name"] for t in resp.json()["tags"]} == {"求职", "新标签"}
    tags = {t["name"]: t["block_count"] for t in client.get("/api/tags").json()["tags"]}
    assert tags["新标签"] == 1
    # 旧标签无块引用后计数为 0（仍列出，供管理）
    assert tags["旧标签"] == 0


def test_update_block_tags_empty_clears(client: TestClient) -> None:
    block_id = create_block(client, "姓名", "张三", tags=["求职"]).json()["id"]
    resp = client.put(f"/api/blocks/{block_id}", json={"tags": []})
    assert resp.status_code == 200
    assert resp.json()["tags"] == []


def test_update_block_404(client: TestClient) -> None:
    resp = client.put("/api/blocks/999", json={"content": "内容"})
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "BLOCK_NOT_FOUND"


def test_delete_block_soft(client: TestClient) -> None:
    block_id = create_block(client, "姓名", "张三").json()["id"]
    assert client.delete(f"/api/blocks/{block_id}").status_code == 204
    # 列表不再出现；详情 404；再删幂等拒绝
    assert [b["id"] for b in client.get("/api/blocks").json()["blocks"]] == []
    assert client.get(f"/api/blocks/{block_id}").status_code == 404
    assert client.delete(f"/api/blocks/{block_id}").status_code == 404


def test_delete_block_sets_bindings_missing(client: TestClient) -> None:
    """D11 全链路：软删块 → 关联绑定同事务置 missing（repo 原子性的 API 级验证）。"""
    from app.models.db import get_conn, utcnow

    block_id = create_block(client, "姓名", "张三").json()["id"]
    now = utcnow()
    with get_conn() as conn:  # 直播种模板/版本/区域/绑定（上传链路属 M3a/M6a 测试职责）
        conn.execute(
            "INSERT INTO templates (id, filename, storage_name, sha256, status, "
            "created_at, updated_at) VALUES (1, 't.docx', '1_t.docx', ?, 'pending_review', ?, ?)",
            ("a" * 64, now, now),
        )
        conn.execute(
            "INSERT INTO versions (id, template_id, name, created_at, updated_at) "
            "VALUES (1, 1, '默认版本', ?, ?)",
            (now, now),
        )
        conn.execute(
            "INSERT INTO regions (id, template_id, type, label, placeholder, anchor, "
            "order_index, review_status, created_at, updated_at) "
            "VALUES (1, 1, 'custom', '姓名', '{{姓名}}', '{\"kind\":\"p\",\"path\":[0]}', "
            "0, 'pending', ?, ?)",
            (now, now),
        )
        conn.execute(
            "INSERT INTO bindings (id, version_id, region_id, block_id, status, "
            "created_at, updated_at) VALUES (1, 1, 1, ?, 'active', ?, ?)",
            (block_id, now, now),
        )

    assert client.delete(f"/api/blocks/{block_id}").status_code == 204
    with get_conn() as conn:
        row = conn.execute(
            "SELECT status FROM bindings WHERE version_id = 1 AND region_id = 1"
        ).fetchone()
    assert row is not None
    assert row[0] == "missing"
