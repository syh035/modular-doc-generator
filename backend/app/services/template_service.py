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
    TEMPLATE_ALREADY_EXISTS,
    TEMPLATE_CORRUPT,
    TEMPLATE_ENCRYPTED,
    TEMPLATE_NOT_DOCX,
    AppError,
)
from app.models.db import get_conn
from app.models.entities import Region, Template
from app.models.repositories import regions as regions_repo
from app.models.repositories import templates as templates_repo
from app.models.repositories import versions as versions_repo
from app.services.docx_parser import parse_placeholders

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


def upload_template(filename: str, data: bytes) -> tuple[Template, list[Region]]:
    """上传模板：校验 → 建档 → 落盘 → 解析 → 默认版本 → 状态推进 pending_review。

    返回 (模板, 区域列表)。同 sha256 内容重复上传 → 409 拒绝
    （按内容指纹重传关联/迁移属 M3b，此处不越界）。
    """
    sha256 = _validate(filename, data)
    safe_name = safe_basename(filename)

    with get_conn() as conn:
        existing = templates_repo.find_by_sha256(conn, sha256)
        if existing is not None:
            raise AppError(
                TEMPLATE_ALREADY_EXISTS,
                f"相同内容的模板已存在（{existing.filename}，上传于 {existing.created_at}），"
                "无需重复导入",
                status_code=409,
            )
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
                parsed = parse_placeholders(data)
            except AppError:
                raise
            except Exception as exc:  # 畸形 XML 等底层解析失败统一兜底
                raise AppError(TEMPLATE_CORRUPT, "文件已损坏，无法解析正文内容") from exc
            for r in parsed:
                regions_repo.create_region(
                    conn,
                    tpl.id,
                    region_type="custom",  # 词表启发式类型推断属 M3b
                    label=r.label,
                    placeholder=r.placeholder,
                    anchor=r.anchor,
                    order_index=r.order_index,
                )
            versions_repo.create_version(conn, tpl.id, DEFAULT_VERSION_NAME)
            updated = templates_repo.update_template(
                conn, tpl.id, status="pending_review", storage_name=storage_name
            )
            assert updated is not None
            tpl = updated
        except BaseException:
            dest.unlink(missing_ok=True)  # 失败清残：落盘文件（DB 记录随事务回滚）
            raise
        return tpl, regions_repo.list_regions(conn, tpl.id)
