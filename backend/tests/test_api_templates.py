"""/api/templates 测试：上传 201、四类校验错误、重复 409、列表/详情/区域/404。"""

from io import BytesIO
from pathlib import Path
from zipfile import ZipFile

from docx import Document
from fastapi.testclient import TestClient

OLE_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"


def make_docx(text: str = "{{姓名}}求职，电话{{电话}}") -> bytes:
    doc = Document()
    doc.add_paragraph(text)
    buf = BytesIO()
    doc.save(buf)
    return buf.getvalue()


def post_upload(client: TestClient, filename: str, data: bytes) -> object:
    return client.post(
        "/api/templates", files={"file": (filename, data, "application/octet-stream")}
    )


# ---- 上传成功 ----


def test_upload_201_with_regions(client: TestClient) -> None:
    resp = post_upload(client, "我的模板.docx", make_docx())
    assert resp.status_code == 201
    body = resp.json()
    assert body["filename"] == "我的模板.docx"
    assert body["status"] == "pending_review"
    assert body["storage_name"] == f"{body['id']}_我的模板.docx"
    assert len(body["sha256"]) == 64
    labels = [r["label"] for r in body["regions"]]
    assert labels == ["姓名", "电话"]
    region = body["regions"][0]
    assert region["type"] == "custom"
    assert region["placeholder"] == "{{姓名}}"
    assert region["anchor"]["kind"] == "p"
    assert region["review_status"] == "pending"
    assert region["bbox"] is None


def test_upload_writes_file_and_db(client: TestClient, tmp_path: Path) -> None:
    data = make_docx()
    body = post_upload(client, "落盘.docx", data).json()
    stored = tmp_path / "templates" / body["storage_name"]
    assert stored.is_file()
    assert stored.read_bytes() == data


# ---- 校验错误（统一 error 结构）----


def test_upload_not_docx(client: TestClient) -> None:
    resp = post_upload(client, "旧格式.doc", make_docx())
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "TEMPLATE_NOT_DOCX"


def test_upload_encrypted(client: TestClient) -> None:
    resp = post_upload(client, "加密.docx", OLE_MAGIC + b"\x00" * 32)
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "TEMPLATE_ENCRYPTED"


def test_upload_corrupt(client: TestClient) -> None:
    resp = post_upload(client, "损坏.docx", b"plain junk bytes")
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "TEMPLATE_CORRUPT"


def test_upload_zip_missing_document(client: TestClient) -> None:
    buf = BytesIO()
    with ZipFile(buf, "w") as zf:
        zf.writestr("other.txt", "x")
    resp = post_upload(client, "缺正文.docx", buf.getvalue())
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "TEMPLATE_CORRUPT"


def test_upload_duplicate_409(client: TestClient) -> None:
    data = make_docx()
    assert post_upload(client, "a.docx", data).status_code == 201
    resp = post_upload(client, "b.docx", data)
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "TEMPLATE_ALREADY_EXISTS"


def test_upload_same_name_different_content(client: TestClient) -> None:
    """同名允许重复导入（PRD 4.2），记录天然区分。"""
    assert post_upload(client, "同名.docx", make_docx("A{{姓名}}")).status_code == 201
    assert post_upload(client, "同名.docx", make_docx("B{{姓名}}")).status_code == 201
    listing = client.get("/api/templates").json()["templates"]
    assert len(listing) == 2
    assert {t["filename"] for t in listing} == {"同名.docx"}


# ---- 列表 / 详情 / 区域 / 404 ----


def test_list_templates(client: TestClient) -> None:
    post_upload(client, "t1.docx", make_docx("{{姓名}}"))
    post_upload(client, "t2.docx", make_docx("{{姓名}}{{电话}}{{邮箱}}"))
    items = client.get("/api/templates").json()["templates"]
    # 最新在前（M1 约定），附区域数摘要
    assert [t["filename"] for t in items] == ["t2.docx", "t1.docx"]
    assert [t["regions_count"] for t in items] == [3, 1]
    assert "regions" not in items[0]  # 列表不带全量区域


def test_get_template_detail(client: TestClient) -> None:
    body = post_upload(client, "详情.docx", make_docx("{{姓名}}")).json()
    detail = client.get(f"/api/templates/{body['id']}").json()
    assert detail["id"] == body["id"]
    assert [r["label"] for r in detail["regions"]] == ["姓名"]


def test_get_regions(client: TestClient) -> None:
    body = post_upload(client, "区域.docx", make_docx("{{姓名}}{{电话}}")).json()
    resp = client.get(f"/api/templates/{body['id']}/regions")
    assert resp.status_code == 200
    payload = resp.json()
    assert payload["template_id"] == body["id"]
    assert [r["order_index"] for r in payload["regions"]] == [0, 1]


def test_template_not_found_404(client: TestClient) -> None:
    for path in ("/api/templates/999", "/api/templates/999/regions"):
        resp = client.get(path)
        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "TEMPLATE_NOT_FOUND"
