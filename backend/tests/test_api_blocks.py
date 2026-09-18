"""/api/blocks 测试（M6a 最小块 API）：创建 201、字段校验 400、列表。"""

from fastapi.testclient import TestClient


def create_block(client: TestClient, name: str, content: str, category: str = "未分类"):
    return client.post(
        "/api/blocks", json={"name": name, "content": content, "category": category}
    )


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
