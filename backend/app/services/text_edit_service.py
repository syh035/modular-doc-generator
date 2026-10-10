"""版本内文字微调：块变更与绑定同一事务，不修改模板原件。"""

import json

from app.core.config import settings
from app.core.errors import (
    BLOCK_INVALID,
    BLOCK_NOT_FOUND,
    REGION_EXCLUDED,
    REGION_NOT_FOUND,
    REGION_TEMPLATE_MISMATCH,
    REGION_TEXT_CONFLICT,
    RENDER_FAILED,
    VERSION_NOT_FOUND,
    AppError,
)
from app.models.db import get_conn
from app.models.repositories import bindings as bindings_repo
from app.models.repositories import blocks as blocks_repo
from app.models.repositories import regions as regions_repo
from app.models.repositories import templates as templates_repo
from app.models.repositories import versions as versions_repo
from app.services.docx_parser import iter_flow_paragraphs


def save_text(
    version_id: int,
    region_id: int,
    content: str,
    sync_block: bool,
    expected_content: str | None = None,
) -> dict[str, object]:
    if not content.strip() or len(content) > 5000:
        raise AppError(BLOCK_INVALID, "内容不能为空，且不能超过 5000 字", status_code=400)
    with get_conn() as conn:
        conn.execute("BEGIN IMMEDIATE")
        version = versions_repo.get_version(conn, version_id)
        if version is None:
            raise AppError(VERSION_NOT_FOUND, "内容版本不存在", status_code=404)
        region = regions_repo.get_region(conn, region_id)
        if region is None:
            raise AppError(REGION_NOT_FOUND, "区域不存在", status_code=404)
        if region.template_id != version.template_id:
            raise AppError(REGION_TEMPLATE_MISMATCH, "区域不属于当前版本的模板", status_code=400)
        if region.review_status == "excluded":
            raise AppError(REGION_EXCLUDED, "已排除区域不可编辑，请先重新校对", status_code=400)
        binding = bindings_repo.get_binding(conn, version_id, region_id)
        original_block = (
            blocks_repo.get_block(conn, binding.block_id)
            if binding and binding.status == "active"
            else None
        )
        template = templates_repo.get_template(conn, version.template_id)
        assert template is not None
        docx_path = settings.templates_dir / template.storage_name
        if not docx_path.is_file():
            raise AppError(RENDER_FAILED, "模板原件不存在，请重新导入", status_code=500)
        anchor = json.loads(region.anchor)["path"]
        current = (
            original_block.content
            if original_block
            else (
                region.placeholder
                if region.placeholder is not None
                else next(
                    (
                        text
                        for flow_anchor, text in iter_flow_paragraphs(docx_path.read_bytes())
                        if flow_anchor["path"] == anchor
                    ),
                    "",
                )
            )
        )
        if expected_content is not None and expected_content != current:
            raise AppError(
                REGION_TEXT_CONFLICT, "内容已发生变化，请重新打开编辑窗口", status_code=409
            )
        if sync_block:
            if original_block is None:
                raise AppError(BLOCK_NOT_FOUND, "原字符块已不存在，不能同步修改", status_code=404)
            block = blocks_repo.update_block(conn, original_block.id, content=content, kind="text")
            assert block is not None
        elif original_block is not None and original_block.content == content:
            block = original_block
        else:
            name = (region.label.strip() + " · 编辑")[:30]
            block = blocks_repo.create_block(conn, name, content)
            if original_block is not None:
                conn.execute(
                    "INSERT INTO block_tags (block_id, tag_id) SELECT ?, tag_id "
                    "FROM block_tags WHERE block_id = ?",
                    (block.id, original_block.id),
                )
        saved = bindings_repo.upsert_binding(conn, version_id, region_id, block.id)
        return {
            "version_id": version_id,
            "region_id": region_id,
            "block_id": block.id,
            "block_name": block.name,
            "status": saved.status,
        }
