"""/api/blocks 测试（M6a 最小块 API）：创建 201、字段校验、列表；分类功能已移除。"""

import httpx
from fastapi.testclient import TestClient


def create_block(
    client: TestClient,
    name: str,
    content: str,
    tags: list[str] | None = None,
) -> httpx.Response:
    payload: dict = {"name": name, "content": content}
    if tags is not None:
        payload["tags"] = tags
    return client.post("/api/blocks", json=payload)


def test_create_block_201(client: TestClient) -> None:
    resp = create_block(client, "姓名", "张三")
    assert resp.status_code == 201
    body = resp.json()
    assert body["name"] == "姓名"
    assert body["content"] == "张三"
    assert body["id"] > 0
    assert "category" not in body  # 分类功能已移除（2026-09-18）


def test_create_block_name_stripped(client: TestClient) -> None:
    body = create_block(client, "  电话  ", "138").json()
    assert body["name"] == "电话"


def test_create_block_name_too_short(client: TestClient) -> None:
    resp = create_block(client, " ", "内容")
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


def test_list_blocks_updated_desc(client: TestClient) -> None:
    create_block(client, "块A", "内容A")
    create_block(client, "块B", "内容B")
    # 块A 刚编辑过 → 更新时间最新，应排最前（平铺按更新时间倒序）
    block_a = next(b for b in client.get("/api/blocks").json()["blocks"] if b["name"] == "块A")
    resp = client.put(f"/api/blocks/{block_a['id']}", json={"content": "内容A改"})
    assert resp.status_code == 200
    items = client.get("/api/blocks").json()["blocks"]
    assert [b["name"] for b in items] == ["块A", "块B"]


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
    block_id = create_block(client, "姓名", "张三", tags=["求职"]).json()["id"]
    resp = client.put(f"/api/blocks/{block_id}", json={"content": "李四"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["content"] == "李四"
    assert body["name"] == "姓名"  # 未传字段保持
    assert [t["name"] for t in body["tags"]] == ["求职"]  # tags 未传不动


def test_update_block_full_validation(client: TestClient) -> None:
    block_id = create_block(client, "姓名", "张三").json()["id"]
    resp = client.put(f"/api/blocks/{block_id}", json={"name": " "})  # 与现内容组合校验
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "BLOCK_INVALID"


def test_update_block_replace_tags_prunes_orphans(client: TestClient) -> None:
    """标签整组替换：被摘除且无块引用的标签自动删除（2026-09-18 用户确认）。"""
    block_id = create_block(client, "姓名", "张三", tags=["求职", "旧标签"]).json()["id"]
    resp = client.put(f"/api/blocks/{block_id}", json={"tags": ["求职", "新标签"]})
    assert resp.status_code == 200
    assert {t["name"] for t in resp.json()["tags"]} == {"求职", "新标签"}
    tag_names = {t["name"] for t in client.get("/api/tags").json()["tags"]}
    assert "新标签" in tag_names
    assert "旧标签" not in tag_names  # 无块引用 → 已被自动清理


def test_update_block_tags_empty_clears(client: TestClient) -> None:
    block_id = create_block(client, "姓名", "张三", tags=["求职"]).json()["id"]
    resp = client.put(f"/api/blocks/{block_id}", json={"tags": []})
    assert resp.status_code == 200
    assert resp.json()["tags"] == []
    assert client.get("/api/tags").json()["tags"] == []  # 求职标签无引用 → 自动清理


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


def test_delete_block_prunes_orphan_tags(client: TestClient) -> None:
    """删块后无存活块引用的标签自动清理（2026-09-18 用户确认）。"""
    create_block(client, "块甲", "内容", tags=["独占标签"]).json()
    create_block(client, "块乙", "内容", tags=["共享标签"]).json()
    # 删掉引用「独占标签」的块 → 标签消失；共享标签仍有块引用 → 保留
    block_a = next(b for b in client.get("/api/blocks").json()["blocks"] if b["name"] == "块甲")
    assert client.delete(f"/api/blocks/{block_a['id']}").status_code == 204
    tag_names = {t["name"] for t in client.get("/api/tags").json()["tags"]}
    assert "独占标签" not in tag_names
    assert "共享标签" in tag_names


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


def test_one_character_block_name_matches_ui_contract(client: TestClient) -> None:
    resp = create_block(client, "名", "内容")
    assert resp.status_code == 201
    assert client.put(f"/api/blocks/{resp.json()['id']}", json={"name": "字"}).status_code == 200


def test_template_library_retains_members_across_versions_and_unbind(client: TestClient) -> None:
    from tests.test_api_versions import bind, make_block, make_docx, upload

    a = upload(client, make_docx("模板 A {{姓名}} {{电话}}"))
    b = upload(client, make_docx("模板 B {{姓名}}"))
    one = make_block(client, "A 块", "A")
    two = make_block(client, "B 块", "B")
    three = make_block(client, "未绑定", "C")
    extra = client.post(f"/api/templates/{a['id']}/versions", json={"name": "第二版"})
    assert extra.status_code == 201
    second_version = extra.json()["id"]
    rid = a["regions"][0]["id"]
    assert bind(client, a["default_version_id"], rid, one).status_code == 200
    assert bind(client, second_version, rid, one).status_code == 200
    assert bind(client, second_version, a["regions"][1]["id"], two).status_code == 200
    assert bind(client, b["default_version_id"], b["regions"][0]["id"], two).status_code == 200

    def ids(template_id: int | None = None) -> set[int]:
        response = client.get(
            "/api/blocks", params={} if template_id is None else {"template_id": template_id}
        )
        assert response.status_code == 200
        return {block["id"] for block in response.json()["blocks"]}

    assert ids() == {one, two, three}
    assert ids(a["id"]) == {one, two}  # shared block deduplicated across versions
    assert ids(b["id"]) == {two}
    assert ids(999999) == set()
    assert (
        client.delete(
            f"/api/versions/{second_version}/bindings/{a['regions'][1]['id']}"
        ).status_code
        == 204
    )
    assert ids(a["id"]) == {one, two}
    assert client.delete(f"/api/blocks/{one}").status_code == 204
    assert ids(a["id"]) == {two}
    assert ids(b["id"]) == {two}


def test_create_template_member_share_and_history(client: TestClient) -> None:
    from tests.test_api_versions import make_docx, upload

    a = upload(client, make_docx("A {{姓名}}"))
    b = upload(client, make_docx("B {{姓名}}"))
    created = client.post(
        "/api/blocks", json={"name": "模板新块", "content": "保留内容", "template_id": a["id"]}
    )
    assert created.status_code == 201
    block_id = created.json()["id"]

    def ids(tid: int) -> list[int]:
        return [
            block["id"]
            for block in client.get("/api/blocks", params={"template_id": tid}).json()["blocks"]
        ]

    assert ids(a["id"]) == [block_id]  # Visible before any region is bound.
    assert ids(b["id"]) == []
    assert client.post("/api/history/undo").status_code == 200
    assert ids(a["id"]) == []
    assert client.post("/api/history/redo").status_code == 200
    assert ids(a["id"]) == [block_id]
    share = f"/api/blocks/{block_id}/templates/{b['id']}"
    assert client.post(share).status_code == 200
    assert ids(b["id"]) == [block_id]
    history = client.get("/api/history/status").json()["undo_count"]
    assert client.post(share).status_code == 200
    assert client.get("/api/history/status").json()["undo_count"] == history
    assert client.post("/api/history/undo").status_code == 200
    assert ids(b["id"]) == [] and ids(a["id"]) == [block_id]
    assert client.post("/api/history/redo").status_code == 200
    assert client.put(f"/api/blocks/{block_id}", json={"content": "共享更新"}).status_code == 200
    assert (
        client.get("/api/blocks", params={"template_id": b["id"]}).json()["blocks"][0]["content"]
        == "共享更新"
    )
    assert client.delete(f"/api/templates/{a['id']}").status_code == 204
    assert ids(b["id"]) == [block_id]
    assert client.get(f"/api/blocks/{block_id}").status_code == 200


def test_template_member_invalid_targets_do_not_create_assets(client: TestClient) -> None:
    from tests.test_api_versions import make_block, make_docx, upload

    before = client.get("/api/blocks").json()
    assert (
        client.post(
            "/api/blocks", json={"name": "不会创建", "content": "内容", "template_id": 999999}
        ).status_code
        == 404
    )
    assert client.get("/api/blocks").json() == before
    template = upload(client, make_docx("测试 {{姓名}}"))
    block_id = make_block(client, "原块", "内容")
    assert client.post(f"/api/blocks/{block_id}/templates/999999").status_code == 404
    assert client.post(f"/api/blocks/999999/templates/{template['id']}").status_code == 404
    assert client.delete(f"/api/blocks/{block_id}").status_code == 204
    assert client.post(f"/api/blocks/{block_id}/templates/{template['id']}").status_code == 404
