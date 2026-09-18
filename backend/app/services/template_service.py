"""模板上传编排：校验 → 建档（parsing）→ 落盘 → 占位符解析 → 区域落库 → 待校对。

校验链（PRD 4.2）：仅收 .docx（旧格式提示转换）、加密/旧格式 OLE 头
→ 明确报错、损坏 zip → 明确报错；同名不同内容文件靠记录天然区分
（storage_name = {id}_{原名}，M1 假设③）。

失败不留残迹：DB 记录靠 get_conn 事务回滚，落盘文件在异常路径清理。
解析同步完成（D12：10 页内 ≤5s 基线），无需异步轮询。
"""

import hashlib
import zipfile
from io import BytesIO
from pathlib import Path

from app.core.config import settings
from app.core.errors import (
    TEMPLATE_CORRUPT,
    TEMPLATE_ENCRYPTED,
    TEMPLATE_IMAGE_ONLY,
    TEMPLATE_NOT_DOCX,
    AppError,
)
from app.models.db import get_conn
from app.models.entities import Region, Template
from app.models.repositories import regions as regions_repo
from app.models.repositories import templates as templates_repo
from app.models.repositories import versions as versions_repo
from app.services.docx_parser import parse_candidates

# OLE2 复合文档魔数：加密 DOCX 与旧格式 .doc 共用的文件头
_OLE_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"

_DOCX_SUFFIX = ".docx"

# 上传成功即创建默认版本（M6a 假设②：绑定归属版本，前端凭此直接可用；
# 完整版本管理——新建/复制/切换/删除保护——属 M8）
DEFAULT_VERSION_NAME = "默认版本"


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
