"""模板上传编排：校验 → 建档（parsing）→ 落盘 → 占位符解析 → 区域落库 → 待校对。

校验链（PRD 4.2）：仅收 .docx（旧格式提示转换）、加密/旧格式 OLE 头
→ 明确报错、损坏 zip → 明确报错；同名不同内容文件靠记录天然区分
（storage_name = {id}_{原名}，M1 假设③）。

失败不留残迹：DB 记录靠 get_conn 事务回滚，落盘文件在异常路径清理。
解析同步完成（D12：10 页内 ≤5s 基线），无需异步轮询。
"""

import hashlib
import json
import logging
import sqlite3
import zipfile
from io import BytesIO
from pathlib import Path
from typing import cast
from uuid import uuid4

from app.core.config import settings
from app.core.errors import (
    TEMPLATE_CORRUPT,
    TEMPLATE_DELETE_FAILED,
    TEMPLATE_ENCRYPTED,
    TEMPLATE_IMAGE_ONLY,
    TEMPLATE_IN_USE,
    TEMPLATE_NOT_DOCX,
    TEMPLATE_NOT_FOUND,
    AppError,
)
from app.models.db import get_conn
from app.models.entities import Region, Template
from app.models.repositories import regions as regions_repo
from app.models.repositories import templates as templates_repo
from app.models.repositories import versions as versions_repo
from app.services.docx_parser import iter_flow_paragraphs, parse_candidates
from app.services.field_lexicon import PARAGRAPH_MIN_LEN, was_legacy_field_paragraph

# OLE2 复合文档魔数：加密 DOCX 与旧格式 .doc 共用的文件头
_OLE_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"

_DOCX_SUFFIX = ".docx"

# 上传成功即创建默认版本（M6a 假设②：绑定归属版本，前端凭此直接可用；
# 完整版本管理——新建/复制/切换/删除保护——属 M8）
DEFAULT_VERSION_NAME = "默认版本"


def upgrade_full_candidates(conn: sqlite3.Connection) -> int:
    """仅一次为旧模板追加过去跳过的短文字；不覆盖人工区域与已排除项。"""
    if not conn.in_transaction:
        conn.execute("BEGIN IMMEDIATE")
    added = 0
    for tpl in templates_repo.list_templates(conn):
        if conn.execute(
            "SELECT 1 FROM template_candidate_scans WHERE template_id = ?", (tpl.id,)
        ).fetchone():
            continue
        path = settings.templates_dir / tpl.storage_name
        if not path.is_file():
            continue
        existing = regions_repo.list_regions(conn, tpl.id)
        anchors = {tuple(json.loads(region.anchor)["path"]) for region in existing}
        order = regions_repo.max_order_index(conn, tpl.id) + 1
        try:
            data = path.read_bytes()
            candidates = parse_candidates(data).candidates
            original_by_path = {
                tuple(cast(list[int], anchor["path"])): text.strip()
                for anchor, text in iter_flow_paragraphs(data)
            }
        except Exception:
            # 历史原件可能被外部损坏，跳过升级但不阻断整个应用启动。
            logging.getLogger(__name__).warning("跳过不可解析的历史模板 id=%s", tpl.id)
            continue
        for candidate in candidates:
            key = tuple(cast(list[int], candidate.anchor["path"]))
            if key in anchors:
                continue
            # 过去已经识别却被用户物理删除的候选不重新创建。
            if candidate.placeholder is not None:
                continue
            # 候选 label 会截断；按原始文档流文字判断旧规则。
            original = original_by_path[key]
            if len(original) >= PARAGRAPH_MIN_LEN or was_legacy_field_paragraph(original):
                continue
            regions_repo.create_region(
                conn,
                tpl.id,
                region_type=candidate.region_type,
                label=candidate.label,
                placeholder=candidate.placeholder,
                anchor=candidate.anchor,
                order_index=order,
                confidence=candidate.confidence,
            )
            order += 1
            anchors.add(key)
            added += 1
        upgraded = regions_repo.list_regions(conn, tpl.id)
        if len(upgraded) > len(existing):
            # 补齐后保持 D7 文档流顺序；身份、人工状态与绑定不变。
            upgraded.sort(
                key=lambda region: (tuple(json.loads(region.anchor)["path"]), region.order_index)
            )
            for position, region in enumerate(upgraded):
                regions_repo.update_region(conn, region.id, order_index=position)
            templates_repo.update_template(conn, tpl.id, status="pending_review")
        conn.execute(
            "INSERT INTO template_candidate_scans (template_id, revision) VALUES (?, 2)", (tpl.id,)
        )
    return added


def upgrade_pending_candidate_types(conn: sqlite3.Connection) -> int:
    """M15 一次升级未校对自动 custom 分类，保留人工状态、区域身份与绑定。"""
    if not conn.in_transaction:
        conn.execute("BEGIN IMMEDIATE")
    updated = 0
    for tpl in templates_repo.list_templates(conn):
        scan = conn.execute(
            "SELECT revision FROM template_candidate_scans WHERE template_id = ?", (tpl.id,)
        ).fetchone()
        if scan and scan["revision"] >= 3:
            continue
        path = settings.templates_dir / tpl.storage_name
        if not path.is_file():
            continue
        try:
            candidates = parse_candidates(path.read_bytes()).candidates
        except Exception:
            logging.getLogger(__name__).warning("跳过不可解析的词表升级模板 id=%s", tpl.id)
            continue
        by_anchor = {
            (tuple(cast(list[int], candidate.anchor["path"])), candidate.placeholder): candidate
            for candidate in candidates
        }
        for region in regions_repo.list_regions(conn, tpl.id):
            if (
                region.type != "custom"
                or region.review_status != "pending"
                or region.bbox_source != "auto"
                or region.confidence not in (0.4, 1.0)
            ):
                continue
            key = (tuple(json.loads(region.anchor)["path"]), region.placeholder)
            candidate = by_anchor.get(key)
            if candidate and candidate.region_type != "custom":
                regions_repo.update_region(
                    conn,
                    region.id,
                    region_type=candidate.region_type,
                    confidence=candidate.confidence,
                )
                updated += 1
        conn.execute(
            "INSERT INTO template_candidate_scans (template_id, revision) VALUES (?, 3) "
            "ON CONFLICT(template_id) DO UPDATE SET revision = 3",
            (tpl.id,),
        )
    return updated


def delete_template(template_id: int) -> None:
    """保护有效绑定；级联删元数据，提交失败恢复暂存原件。"""
    original: Path | None = None
    staged: Path | None = None
    try:
        with get_conn() as conn:
            conn.execute("BEGIN IMMEDIATE")  # 保护检查与删除之间禁止并发新增绑定
            tpl = templates_repo.get_template(conn, template_id)
            if tpl is None:
                raise AppError(TEMPLATE_NOT_FOUND, "模板不存在", status_code=404)
            count = conn.execute(
                "SELECT COUNT(*) FROM bindings b JOIN versions v ON v.id = b.version_id "
                "WHERE v.template_id = ? AND b.status = 'active'",
                (template_id,),
            ).fetchone()[0]
            if count:
                raise AppError(
                    TEMPLATE_IN_USE,
                    f"模板仍有 {count} 项有效绑定，请先解绑或删除对应字符块",
                    status_code=409,
                )
            original = (settings.templates_dir / tpl.storage_name).resolve()
            if original.parent != settings.templates_dir.resolve():
                raise AppError(TEMPLATE_DELETE_FAILED, "模板原件路径异常", status_code=500)
            if original.exists():
                target = original.with_name(f".delete-{uuid4().hex}")
                original.rename(target)
                staged = target
            conn.execute("DELETE FROM templates WHERE id = ?", (template_id,))
    except BaseException as exc:
        if staged is not None and original is not None:
            staged.rename(original)
        if isinstance(exc, OSError):
            raise AppError(
                TEMPLATE_DELETE_FAILED, "无法移除模板原件，请检查文件权限后重试", status_code=500
            ) from exc
        raise
    if staged is not None:
        try:
            staged.unlink()
        except OSError:
            # 元数据已提交，不能误报删除失败；异常暂存件不再参与应用读取。
            logging.getLogger(__name__).warning("模板删除后暂存文件清理失败")


def safe_basename(filename: str) -> str:
    """取纯文件名（剥离路径部分，防 multipart 文件名携带路径分隔符）。"""
    return Path(filename.replace("\\", "/")).name.strip()


def _validate(filename: str, data: bytes) -> str:
    """上传校验链，返回内容 SHA-256 指纹（D10 地基）。"""
    name = safe_basename(filename)
    if not name.lower().endswith(_DOCX_SUFFIX):
        raise AppError(
            TEMPLATE_NOT_DOCX,
            "仅支持 .docx 模板文件；.doc 等旧格式请先用 Word 另存为 .docx 再上传",
        )
    if not data:
        raise AppError(TEMPLATE_CORRUPT, "文件内容为空，无法解析")
    if data.startswith(_OLE_MAGIC):
        raise AppError(
            TEMPLATE_ENCRYPTED,
            "文件已加密或为旧格式 .doc，请解除密码/另存为 .docx 后重新上传",
        )
    if not zipfile.is_zipfile(BytesIO(data)):
        raise AppError(TEMPLATE_CORRUPT, "文件已损坏，无法作为 DOCX 打开")
    with zipfile.ZipFile(BytesIO(data)) as zf:
        if "word/document.xml" not in zf.namelist():
            raise AppError(TEMPLATE_CORRUPT, "文件结构不完整（缺少正文），无法解析")
    return hashlib.sha256(data).hexdigest()


def upload_template(filename: str, data: bytes) -> tuple[Template, list[Region], bool]:
    """上传模板：校验 → 指纹关联 → 建档 → 落盘 → 候选解析 → 默认版本。

    返回 (模板, 区域列表, reused)。D10：同 sha256 内容重传 → 关联已有
    模板幂等返回（reused=True，不重复建档/解析）；正文无任何文本层的
    纯图片模板 → TEMPLATE_IMAGE_ONLY 拒绝（D6 扫描范围内识别不到区域，
    此类模板不适用）。
    """
    sha256 = _validate(filename, data)
    safe_name = safe_basename(filename)

    with get_conn() as conn:
        existing = templates_repo.find_by_sha256(conn, sha256)
        if existing is not None:
            # D10 指纹关联：解析结果与版本均属已有模板，直接复用
            return existing, regions_repo.list_regions(conn, existing.id), True
        tpl = templates_repo.create_template(
            conn, filename=safe_name, storage_name="", sha256=sha256
        )
        # storage_name 依赖建档所得 id：{id}_{原名}（假设③），同事务内回填
        storage_name = f"{tpl.id}_{safe_name}"
        dest = settings.templates_dir / storage_name
        try:
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)
            try:
                outcome = parse_candidates(data)
            except AppError:
                raise
            except Exception as exc:  # 畸形 XML 等底层解析失败统一兜底
                raise AppError(TEMPLATE_CORRUPT, "文件已损坏，无法解析正文内容") from exc
            if not outcome.has_any_text:
                raise AppError(
                    TEMPLATE_IMAGE_ONLY,
                    "模板正文未发现任何文本层（纯图片模板），无法识别可替换区域，"
                    "此类模板不适用；请使用含文本的 DOCX 模板",
                    status_code=400,
                )
            for c in outcome.candidates:
                regions_repo.create_region(
                    conn,
                    tpl.id,
                    region_type=c.region_type,
                    label=c.label,
                    placeholder=c.placeholder,
                    anchor=c.anchor,
                    order_index=c.order_index,
                    confidence=c.confidence,
                )
            conn.execute(
                "INSERT INTO template_candidate_scans (template_id, revision) VALUES (?, 3)",
                (tpl.id,),
            )
            # Q3 空集豁免：无任何候选区域 → 校对无事可做，直接 ready
            next_status = "ready" if not outcome.candidates else "pending_review"
            versions_repo.create_version(conn, tpl.id, DEFAULT_VERSION_NAME)
            updated = templates_repo.update_template(
                conn, tpl.id, status=next_status, storage_name=storage_name
            )
            assert updated is not None
            tpl = updated
        except BaseException:
            dest.unlink(missing_ok=True)  # 失败清残：落盘文件（DB 记录随事务回滚）
            raise
        return tpl, regions_repo.list_regions(conn, tpl.id), False
