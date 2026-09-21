"""/api/versions 测试（M6a）：默认版本、绑定 CRUD、版本渲染（假 LO）+ 真实 LO 端到端。"""

from io import BytesIO
from pathlib import Path
from types import SimpleNamespace

import pymupdf
import pytest
from docx import Document
from fastapi.testclient import TestClient

from app.services.libreoffice import find_soffice


def make_docx(text: str = "电话：{{手机号}}，姓名：{{姓名}}") -> bytes:
    doc = Document()
    doc.add_paragraph(text)
    buf = BytesIO()
    doc.save(buf)
    return buf.getvalue()


def upload(client: TestClient, data: bytes) -> dict:
    resp = client.post(
        "/api/templates",
        files={"file": ("模板.docx", data, "application/octet-stream")},
    )
    assert resp.status_code == 201
    return resp.json()


def setup_version(client: TestClient, data: bytes) -> tuple[int, list[dict]]:
    """上传模板 → 返回 (默认版本 id, 区域列表)。"""
    body = upload(client, data)
    assert body["default_version_id"] is not None
    return body["default_version_id"], body["regions"]


def make_block(client: TestClient, name: str, content: str) -> int:
    resp = client.post("/api/blocks", json={"name": name, "content": content})
    assert resp.status_code == 201
    return resp.json()["id"]


def bind(client: TestClient, version_id: int, region_id: int, block_id: int):
    return client.post(
        f"/api/versions/{version_id}/bindings",
        json={"region_id": region_id, "block_id": block_id},
    )


def fake_pdf_with(tmp_path: Path, text: str) -> Path:
    """造一份含指定文本的「渲染 PDF」（绕开 LO 验证替换-对齐链路）。"""
    pdf = tmp_path / f"fake_{abs(hash(text))}.pdf"
    doc = pymupdf.open()
    page = doc.new_page()
    page.insert_text((72, 100), text, fontname="china-s")
    doc.save(pdf)
    doc.close()
    return pdf


# ---- 默认版本 ----


def test_upload_creates_default_version(client: TestClient) -> None:
    body = upload(client, make_docx())
    assert body["default_version_id"] > 0
    detail = client.get(f"/api/templates/{body['id']}").json()
    assert detail["default_version_id"] == body["default_version_id"]


# ---- 绑定 CRUD ----


def test_bind_and_rebind_upsert(client: TestClient) -> None:
    vid, regions = setup_version(client, make_docx())
    rid = regions[0]["id"]
    b1 = make_block(client, "手机号A", "138")
    b2 = make_block(client, "手机号B", "139")

    resp = bind(client, vid, rid, b1)
    assert resp.status_code == 200
    assert resp.json()["block_id"] == b1
    assert resp.json()["status"] == "active"

    # 换绑：同端点覆盖
    resp = bind(client, vid, rid, b2)
    assert resp.status_code == 200
    assert resp.json()["block_id"] == b2

    items = client.get(f"/api/versions/{vid}/bindings").json()["bindings"]
    assert len(items) == 1  # UNIQUE(version, region)：仍是 1 条
    assert items[0]["block_id"] == b2
    assert items[0]["block_name"] == "手机号B"


def test_unbind_204_then_404(client: TestClient) -> None:
    vid, regions = setup_version(client, make_docx())
    rid = regions[0]["id"]
    bid = make_block(client, "手机号", "138")
    assert bind(client, vid, rid, bid).status_code == 200

    resp = client.delete(f"/api/versions/{vid}/bindings/{rid}")
    assert resp.status_code == 204
    resp = client.delete(f"/api/versions/{vid}/bindings/{rid}")
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "BINDING_NOT_FOUND"


def test_bind_validations(client: TestClient) -> None:
    vid, regions = setup_version(client, make_docx())
    rid = regions[0]["id"]

    # 版本不存在
    assert bind(client, 999, rid, 1).status_code == 404
    # 区域不存在
    resp = bind(client, vid, 9999, 1)
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "REGION_NOT_FOUND"
    # 块不存在
    resp = bind(client, vid, rid, 9999)
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "BLOCK_NOT_FOUND"

    # 区域不属于该版本所属模板：上传第二个模板做交叉
    other = upload(client, make_docx("别的{{字段}}"))
    other_vid = other["default_version_id"]
    bid = make_block(client, "交叉块", "内容")
    resp = bind(client, other_vid, rid, bid)  # 模板1的区域绑到模板2的版本
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "REGION_TEMPLATE_MISMATCH"


# ---- 版本渲染（假 LO：验证替换 + 对齐 + 绑定态编排）----


def _patch_fake_convert(
    monkeypatch: pytest.MonkeyPatch, pdf_by_text: dict[str, Path]
) -> list[bytes]:
    """按成品 DOCX 正文文本选假 PDF（DOCX 是 zip，须解析后匹配）；记录被转换字节。"""
    seen: list[bytes] = []

    def convert(path: Path) -> Path:
        data = path.read_bytes()
        seen.append(data)
        text = "\n".join(p.text for p in Document(BytesIO(data)).paragraphs)
        for needle, pdf in pdf_by_text.items():
            if needle in text:
                return pdf
        raise AssertionError(f"无匹配假 PDF：{path}")

    monkeypatch.setattr("app.services.libreoffice._manager", SimpleNamespace(convert=convert))
    return seen


def test_version_preview_and_overlay(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """绑定 → 版本预览 PDF = 替换后成品；overlay 带绑定态与替换后 bbox。"""
    tpl_data = make_docx("电话：{{手机号}}，姓名：{{姓名}}")
    vid, regions = setup_version(client, tpl_data)
    by_label = {r["label"]: r for r in regions}
    b_phone = make_block(client, "手机号", "13800138000")
    assert bind(client, vid, by_label["手机号"]["id"], b_phone).status_code == 200
    # 姓名不绑 → 保留占位符

    # 假 PDF 需含替换后文本（几何对齐源）：绑定行 + 保留的占位符行；
    # 模板本体转换（M7 溢出测量触发 ensure 补 bbox）用原文假 PDF
    fake = fake_pdf_with(
        tmp_path, "电话：13800138000，姓名：{{姓名}}"
    )
    fake_tpl = fake_pdf_with(tmp_path, "电话：{{手机号}}，姓名：{{姓名}}")
    _patch_fake_convert(
        monkeypatch, {"电话：13800138000": fake, "电话：{{手机号}}": fake_tpl}
    )

    resp = client.get(f"/api/versions/{vid}/preview")
    assert resp.status_code == 200
    assert resp.content.startswith(b"%PDF")

    overlay = client.get(f"/api/versions/{vid}/overlay").json()
    items = {r["label"]: r for r in overlay["regions"]}
    phone = items["手机号"]
    assert phone["binding"]["block_id"] == b_phone
    assert phone["binding"]["block_name"] == "手机号"
    assert phone["binding"]["status"] == "active"
    assert phone["bbox"] is not None  # 替换后文本对齐成功
    assert items["姓名"]["binding"] is None
    assert items["姓名"]["bbox"] is not None  # 未绑定区域也原位对齐


def test_version_render_unbound_keeps_placeholder(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """零绑定时版本渲染 = 原文（占位符保留），仍是合法 PDF。"""
    vid, _ = setup_version(client, make_docx())
    fake = fake_pdf_with(tmp_path, "电话：{{手机号}}，姓名：{{姓名}}")
    seen = _patch_fake_convert(monkeypatch, {"{{手机号}}": fake})

    assert client.get(f"/api/versions/{vid}/preview").status_code == 200
    doc = Document(BytesIO(seen[0]))  # 送入 LO 的成品 = 原文
    assert doc.paragraphs[0].text == "电话：{{手机号}}，姓名：{{姓名}}"


def test_version_404(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "app.services.libreoffice._manager", SimpleNamespace(convert=lambda p: p)
    )
    for path in ("/api/versions/999/preview", "/api/versions/999/overlay"):
        resp = client.get(path)
        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "VERSION_NOT_FOUND"


# ---- 真实 LibreOffice 端到端 ----


@pytest.mark.skipif(find_soffice() is None, reason="LibreOffice 未安装")
def test_version_render_real_lo(client: TestClient) -> None:
    """里程碑 1 风险链核心：绑定块 → 替换 → LO 渲染 → 文本与坐标可提取。

    python-docx 默认模板 run 无 eastAsia（M4 事实）→ 显式设置，
    保证 CJK 字形渲染（验证墨迹须真实 LO，此处以文本提取 + bbox 为准）。
    """
    doc = Document()
    p = doc.add_paragraph("电话：{{手机号}}")
    run = p.runs[0]
    run.font.name = "宋体"
    run._element.rPr.rFonts.set(
        "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}eastAsia", "宋体"
    )
    buf = BytesIO()
    doc.save(buf)
    tpl_data = buf.getvalue()

    vid, regions = setup_version(client, tpl_data)
    bid = make_block(client, "手机号块", "13800138000")
    assert bind(client, vid, regions[0]["id"], bid).status_code == 200

    resp = client.get(f"/api/versions/{vid}/preview")
    assert resp.status_code == 200
    assert resp.content.startswith(b"%PDF")

    # 成品 PDF 必须含替换文本、不含占位符（文本层验证；墨迹验证见手动验收）
    with pymupdf.open(stream=resp.content) as pdf:
        text = pdf[0].get_text()
    assert "13800138000" in text
    assert "{{手机号}}" not in text

    overlay = client.get(f"/api/versions/{vid}/overlay").json()
    region = overlay["regions"][0]
    assert region["bbox"] is not None
    assert region["binding"]["status"] == "active"


# ---- 版本管理（M8：新建 / 复制底稿 / 重命名 / 删除保护）----


def test_list_versions_with_counts(client: TestClient) -> None:
    """版本列表创建正序 + active 绑定数（missing 不计入）。"""
    tpl = upload(client, make_docx())
    tid, vid, regions = tpl["id"], tpl["default_version_id"], tpl["regions"]
    bid = make_block(client, "手机号块", "138")
    assert bind(client, vid, regions[0]["id"], bid).status_code == 200

    resp = client.get(f"/api/templates/{tid}/versions")
    assert resp.status_code == 200
    versions = resp.json()["versions"]
    assert len(versions) == 1
    assert versions[0]["id"] == vid
    assert versions[0]["name"] == "默认版本"
    assert versions[0]["binding_count"] == 1

    # 软删块 → 绑定 missing → 计数归零
    assert client.delete(f"/api/blocks/{bid}").status_code == 204
    versions = client.get(f"/api/templates/{tid}/versions").json()["versions"]
    assert versions[0]["binding_count"] == 0


def test_create_version_blank(client: TestClient) -> None:
    tpl = upload(client, make_docx())
    tid = tpl["id"]
    resp = client.post(f"/api/templates/{tid}/versions", json={"name": "投递A岗"})
    assert resp.status_code == 201
    body = resp.json()
    assert body["name"] == "投递A岗"
    assert body["template_id"] == tid
    # 空白版本：无绑定
    assert client.get(f"/api/versions/{body['id']}/bindings").json()["bindings"] == []
    # 列表两个版本（默认版本在前）
    names = [v["name"] for v in client.get(f"/api/templates/{tid}/versions").json()["versions"]]
    assert names == ["默认版本", "投递A岗"]


def test_create_version_copy_from(client: TestClient) -> None:
    """复制底稿：active 绑定复制，missing 不迁移。"""
    tpl = upload(client, make_docx())
    tid, vid, regions = tpl["id"], tpl["default_version_id"], tpl["regions"]
    b_keep = make_block(client, "保留块", "138")
    b_gone = make_block(client, "将删块", "zhangsan@example.com")
    assert bind(client, vid, regions[0]["id"], b_keep).status_code == 200
    assert bind(client, vid, regions[1]["id"], b_gone).status_code == 200
    assert client.delete(f"/api/blocks/{b_gone}").status_code == 204  # → missing

    resp = client.post(
        f"/api/templates/{tid}/versions", json={"name": "复制品", "copy_from": vid}
    )
    assert resp.status_code == 201
    new_vid = resp.json()["id"]
    bindings = client.get(f"/api/versions/{new_vid}/bindings").json()["bindings"]
    assert len(bindings) == 1  # missing 不复制
    assert bindings[0]["region_id"] == regions[0]["id"]
    assert bindings[0]["block_id"] == b_keep
    assert bindings[0]["status"] == "active"


def test_create_version_validations(client: TestClient) -> None:
    tpl = upload(client, make_docx())
    tid = tpl["id"]

    # 名称非法：空 / 纯空白 / 超 30 字
    for name in ("", "   ", "a" * 31):
        resp = client.post(f"/api/templates/{tid}/versions", json={"name": name})
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "VERSION_INVALID"

    # 同模板重名 409
    assert client.post(f"/api/templates/{tid}/versions", json={"name": "V1"}).status_code == 201
    resp = client.post(f"/api/templates/{tid}/versions", json={"name": " 默认版本 "})
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "VERSION_NAME_TAKEN"

    # 模板不存在 404
    assert client.post("/api/templates/999/versions", json={"name": "X"}).status_code == 404
    assert client.get("/api/templates/999/versions").status_code == 404

    # copy_from 不存在 404 / 跨模板 400
    resp = client.post(f"/api/templates/{tid}/versions", json={"name": "V2", "copy_from": 999})
    assert resp.status_code == 404
    other = upload(client, make_docx("别的{{字段}}"))
    resp = client.post(
        f"/api/templates/{tid}/versions",
        json={"name": "V3", "copy_from": other["default_version_id"]},
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "VERSION_INVALID"


def test_rename_version(client: TestClient) -> None:
    tpl = upload(client, make_docx())
    tid, vid = tpl["id"], tpl["default_version_id"]

    resp = client.patch(f"/api/versions/{vid}", json={"name": "主力版本"})
    assert resp.status_code == 200
    assert resp.json()["name"] == "主力版本"

    # 撞同模板另一版本名 409
    other = client.post(f"/api/templates/{tid}/versions", json={"name": "备用"}).json()
    resp = client.patch(f"/api/versions/{other['id']}", json={"name": "主力版本"})
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "VERSION_NAME_TAKEN"

    # 非法名 / 不存在
    assert client.patch(f"/api/versions/{vid}", json={"name": "a" * 31}).status_code == 400
    resp = client.patch("/api/versions/999", json={"name": "X"})
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "VERSION_NOT_FOUND"


def test_delete_version_protection(client: TestClient) -> None:
    """删除：级联删绑定；唯一版本拒绝（LAST_VERSION）；不存在 404。"""
    tpl = upload(client, make_docx())
    tid, vid, regions = tpl["id"], tpl["default_version_id"], tpl["regions"]

    # 唯一版本不可删
    resp = client.delete(f"/api/versions/{vid}")
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "LAST_VERSION"

    # 建第二版本并绑定，删除之 → 绑定随级联消失（再访问该版本 404）
    other = client.post(f"/api/templates/{tid}/versions", json={"name": "待删"}).json()
    bid = make_block(client, "手机号块", "138")
    assert bind(client, other["id"], regions[0]["id"], bid).status_code == 200
    assert client.delete(f"/api/versions/{other['id']}").status_code == 204
    assert client.get(f"/api/versions/{other['id']}/bindings").status_code == 404

    # 删完只剩默认版本，再删仍被保护
    assert client.delete(f"/api/versions/{vid}").status_code == 400

    assert client.delete("/api/versions/999").status_code == 404
