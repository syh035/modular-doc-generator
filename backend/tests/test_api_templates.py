"""/api/templates 测试：上传 201、四类校验错误、重复 409、列表/详情/区域/404、预览。"""

from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from zipfile import ZipFile

import pymupdf
import pytest
from docx import Document
from fastapi.testclient import TestClient

from app.services.libreoffice import find_soffice

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
    for path in ("/api/templates/999", "/api/templates/999/regions", "/api/templates/999/preview"):
        resp = client.get(path)
        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "TEMPLATE_NOT_FOUND"


# ---- 预览 PDF（M4）----


def _build_fake_pdf(tmp_path: Path) -> Path:
    """用 pymupdf 造一份与模板文本一致的“渲染 PDF”（绕开 LO 做几何链路验证）。"""
    pdf = tmp_path / "fake_render.pdf"
    doc = pymupdf.open()
    page = doc.new_page()
    # china-s：pymupdf 内置简体中文字体（默认 helv 无 CJK 字形）
    page.insert_text((72, 100), "电话：{{手机号}}", fontname="china-s")
    doc.save(pdf)
    doc.close()
    return pdf


def test_preview_returns_pdf_and_fills_bboxes(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake_pdf = _build_fake_pdf(tmp_path)
    monkeypatch.setattr(
        "app.services.libreoffice._manager",
        SimpleNamespace(convert=lambda p: fake_pdf),
    )
    body = post_upload(client, "预览.docx", make_docx("电话：{{手机号}}")).json()

    resp = client.get(f"/api/templates/{body['id']}/preview")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "application/pdf"
    assert resp.content.startswith(b"%PDF")

    regions = client.get(f"/api/templates/{body['id']}/regions").json()["regions"]
    assert len(regions) == 1
    bbox = regions[0]["bbox"]
    assert bbox is not None
    assert bbox["page"] == 0
    assert 50 < bbox["x0"] < 100  # insert_text x=72
    assert 50 < bbox["y0"] < 105  # 基线 y=100，行框略靠上
    assert bbox["x1"] > bbox["x0"] and bbox["y1"] > bbox["y0"]


def test_preview_geometry_runs_once_then_cached(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """二次预览：bbox 已齐 → 不再重复几何计算（幂等）。"""
    fake_pdf = _build_fake_pdf(tmp_path)
    calls = {"n": 0}

    def counting_convert(p: Path) -> Path:
        calls["n"] += 1
        return fake_pdf

    monkeypatch.setattr(
        "app.services.libreoffice._manager", SimpleNamespace(convert=counting_convert)
    )
    body = post_upload(client, "缓存.docx", make_docx("电话：{{手机号}}")).json()

    assert client.get(f"/api/templates/{body['id']}/preview").status_code == 200
    assert client.get(f"/api/templates/{body['id']}/preview").status_code == 200
    assert calls["n"] == 2  # 真实 manager 有 sha 缓存；此处验证编排幂等


def test_preview_libreoffice_missing_503(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.services.libreoffice._manager", None)
    monkeypatch.setattr("app.services.libreoffice.find_soffice", lambda: None)
    body = post_upload(client, "无LO.docx", make_docx("电话：{{手机号}}")).json()
    resp = client.get(f"/api/templates/{body['id']}/preview")
    assert resp.status_code == 503
    assert resp.json()["error"]["code"] == "LIBREOFFICE_UNAVAILABLE"


@pytest.mark.skipif(find_soffice() is None, reason="LibreOffice 未安装")
def test_preview_end_to_end_real_lo(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """真实链路：上传 → 预览 PDF → 区域 bbox 全部落库（单管线一致性根基）。"""
    doc = Document()
    doc.add_paragraph("张三的简历")
    doc.add_paragraph("电话：{{手机号}}")
    doc.add_paragraph("很长的自我介绍" * 30 + "，评价：{{自我评价}}")  # 折成多行
    tbl = doc.add_table(rows=1, cols=2)
    tbl.cell(0, 0).text = "{{教育经历}}"
    tbl.cell(0, 1).text = "对照单元格"
    buf = BytesIO()
    doc.save(buf)

    body = post_upload(client, "端到端.docx", buf.getvalue()).json()
    tid = body["id"]

    resp = client.get(f"/api/templates/{tid}/preview")
    assert resp.status_code == 200
    assert resp.content.startswith(b"%PDF")

    regions = client.get(f"/api/templates/{tid}/regions").json()["regions"]
    by_label = {r["label"]: r for r in regions}
    assert set(by_label) == {"手机号", "自我评价", "教育经历"}
    for r in regions:
        assert r["bbox"] is not None, f"{r['label']} 未匹配到渲染位置"
        assert r["bbox"]["page"] == 0
    # 文档流顺序：手机号在上、自我评价次之、表格教育经历靠后
    assert by_label["手机号"]["bbox"]["y1"] < by_label["自我评价"]["bbox"]["y0"]
    assert by_label["自我评价"]["bbox"]["y1"] < by_label["教育经历"]["bbox"]["y0"]
    # 折行段落应明显高于单行高度
    assert (
        by_label["自我评价"]["bbox"]["y1"] - by_label["自我评价"]["bbox"]["y0"]
    ) > 30

    # 二次预览：缓存命中，缓存目录恰一份产物
    assert client.get(f"/api/templates/{tid}/preview").status_code == 200
    from app.core.config import settings

    assert len(list(settings.render_cache_dir.glob("*.pdf"))) == 1
