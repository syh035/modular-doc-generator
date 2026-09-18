"""API 入口：/api/blocks（最小块 API，M6a 依赖；完整块库属 M2）。"""

from fastapi import APIRouter
from pydantic import BaseModel

from app.core.errors import BLOCK_INVALID, AppError
from app.models.db import get_conn
from app.models.entities import Block
from app.models.repositories import blocks as blocks_repo

router = APIRouter(prefix="/api")

# PRD 4.3 字段规则：名称 2–30 字、内容 ≤5000 字（D8）；标签/分类完整能力属 M2
_NAME_MIN, _NAME_MAX = 2, 30
_CONTENT_MAX = 5000
_DEFAULT_CATEGORY = "未分类"


class BlockCreate(BaseModel):
    name: str
    content: str
    category: str = _DEFAULT_CATEGORY


def _validate(name: str, content: str, category: str) -> tuple[str, str, str]:
    name = name.strip()
    category = category.strip() or _DEFAULT_CATEGORY
    if not (_NAME_MIN <= len(name) <= _NAME_MAX):
        raise AppError(
            BLOCK_INVALID, f"块名称长度须在 {_NAME_MIN}–{_NAME_MAX} 字之间", status_code=400
        )
    if len(content) > _CONTENT_MAX:
        raise AppError(
            BLOCK_INVALID, f"块内容不能超过 {_CONTENT_MAX} 字（D8）", status_code=400
        )
    if not content.strip():
        raise AppError(BLOCK_INVALID, "块内容不能为空", status_code=400)
    return name, content, category


def _block_dict(b: Block) -> dict[str, object]:
    return {
        "id": b.id,
        "name": b.name,
        "content": b.content,
        "category": b.category,
        "created_at": b.created_at,
        "updated_at": b.updated_at,
    }


@router.post("/blocks", status_code=201)
def create_block(payload: BlockCreate) -> dict[str, object]:
    """新建字符块（M6a 最小实现：名称/内容/分类，标签筛选属 M2）。"""
    name, content, category = _validate(payload.name, payload.content, payload.category)
    with get_conn() as conn:
        block = blocks_repo.create_block(conn, name, content, category)
    return _block_dict(block)


@router.get("/blocks")
def list_blocks() -> dict[str, object]:
    """块列表（存活块，排除软删除，D11）。"""
    with get_conn() as conn:
        items = [_block_dict(b) for b in blocks_repo.list_blocks(conn)]
    return {"blocks": items}
