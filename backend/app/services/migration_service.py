"""换模板迁移业务（M10，PRD 4.7 / D7）。

把旧模板版本的 active 绑定按区域类型迁移到新模板，两段式：plan（纯计算不落库）
→ 前端三清单确认 → apply（整包提交最终映射落库）。块库不动，零重录。

匹配规则（2026-09-21 用户确认）：
- 源 = 指定版本的 active 绑定（missing 态不迁移——异常态不扩散，与 M8 复制底稿同口径）
- 目标 = 新模板默认版本（最早创建），必须空白（0 active 绑定，否则 409）
- 源/目标区域各按 order_index（文档流顺序，D7）排序，同类型内对齐：
  - 源数 == 目标数 → 按序自动匹配（清单① auto）
  - 源数 <  目标数 → 多候选（清单② candidates，按序者预选，用户点选一个）
  - 源数 >  目标数 → 前 N 个自动匹配，多出的绑定进清单③（unmatched，不自动丢弃）
  - 目标无同类型区域 → 清单③（手动指定任意未占用区域或留空）
- custom 类型不参与自动匹配（PRD：命中率低，主要依赖手动指定）：
  有同类型目标 → 清单②；无 → 清单③
- excluded 目标区域不可作候选也不可自动匹配（与绑定规则 REGION_EXCLUDED 同口径）
"""

import sqlite3

from app.core.errors import (
    BLOCK_NOT_FOUND,
    MIGRATION_SAME_TEMPLATE,
    MIGRATION_TARGET_NOT_BLANK,
    REGION_EXCLUDED,
    REGION_NOT_FOUND,
    REGION_TEMPLATE_MISMATCH,
    TEMPLATE_NOT_FOUND,
    VERSION_NOT_FOUND,
    AppError,
)
from app.models.entities import Region, Version
from app.models.repositories import bindings as bindings_repo
from app.models.repositories import blocks as blocks_repo
from app.models.repositories import regions as regions_repo
from app.models.repositories import templates as templates_repo
from app.models.repositories import versions as versions_repo

CUSTOM_TYPE = "custom"


def _default_version_or_none(conn: sqlite3.Connection, template_id: int) -> Version | None:
    """模板默认版本（最早创建即默认，与 api/templates._default_version_id 同规则）。"""
    versions = versions_repo.list_versions(conn, template_id)
    return versions[0] if versions else None


def _guard_pair(conn: sqlite3.Connection, source_version_id: int, target_template_id: int) -> tuple:
    """公共前置校验：源版本存在、目标模板存在、不同模板；返回 (源版本, 目标默认版本)。"""
    source = versions_repo.get_version(conn, source_version_id)
    if source is None:
        raise AppError(
            VERSION_NOT_FOUND, f"源内容版本不存在（id={source_version_id}）", status_code=404
        )
    if templates_repo.get_template(conn, target_template_id) is None:
        raise AppError(
            TEMPLATE_NOT_FOUND, f"模板不存在（id={target_template_id}）", status_code=404
        )
    if source.template_id == target_template_id:
        raise AppError(
            MIGRATION_SAME_TEMPLATE,
            "源版本与目标模板属于同一模板，无需迁移",
            status_code=400,
        )
    target_version = _default_version_or_none(conn, target_template_id)
    if target_version is None:
        raise AppError(
            MIGRATION_TARGET_NOT_BLANK,
            f"目标模板（id={target_template_id}）无内容版本，无法迁移",
            status_code=409,
        )
    active = [
        b for b in bindings_repo.list_bindings(conn, target_version.id) if b.status == "active"
    ]
    if active:
        raise AppError(
            MIGRATION_TARGET_NOT_BLANK,
            f"目标版本「{target_version.name}」已有 {len(active)} 个绑定，请先迁移到空白版本",
            status_code=409,
        )
    return source, target_version


def _option(region: Region) -> dict[str, object]:
    return {"region_id": region.id, "label": region.label, "type": region.type}


def _source_items(conn: sqlite3.Connection, source_version_id: int) -> list[dict[str, object]]:
    """源绑定视图：active 绑定 × 源区域，按区域文档流顺序排列。

    以 list_regions（order_index 序）为主序遍历、绑定查表，天然得到文档流顺序（D7）。
    """
    bindings = {
        b.region_id: b
        for b in bindings_repo.list_bindings(conn, source_version_id)
        if b.status == "active"
    }
    template_id = _template_of_version(conn, source_version_id)
    items: list[dict[str, object]] = []
    for region in regions_repo.list_regions(conn, template_id):
        binding = bindings.get(region.id)
        if binding is None:
            continue  # 无 active 绑定的区域不迁移
        block = blocks_repo.get_block(conn, binding.block_id)
        items.append(
            {
                "source_region_id": region.id,
                "source_label": region.label,
                "type": region.type,
                "block_id": binding.block_id,
                "block_name": block.name if block else None,
            }
        )
    return items


def _template_of_version(conn: sqlite3.Connection, version_id: int) -> int:
    ver = versions_repo.get_version(conn, version_id)
    assert ver is not None  # 调用前 _guard_pair 已确认
    return ver.template_id


def _target_regions(conn: sqlite3.Connection, target_template_id: int) -> list[Region]:
    """目标候选区域：排除 excluded，按文档流顺序。"""
    return [
        r
        for r in regions_repo.list_regions(conn, target_template_id)
        if r.review_status != "excluded"
    ]


def build_plan(
    conn: sqlite3.Connection, source_version_id: int, target_template_id: int
) -> dict[str, object]:
    """计算迁移方案（纯计算不落库）：三清单 + 目标版本信息。"""
    source, target_version = _guard_pair(conn, source_version_id, target_template_id)

    auto: list[dict[str, object]] = []
    candidates: list[dict[str, object]] = []
    unmatched: list[dict[str, object]] = []

    occupied: set[int] = set()  # 自动匹配占用的目标区域
    target_by_type: dict[str, list[Region]] = {}
    for r in _target_regions(conn, target_template_id):
        target_by_type.setdefault(r.type, []).append(r)

    # 源绑定按类型分组（dict 保序：按文档流首次出现序）
    groups: dict[str, list[dict[str, object]]] = {}
    for it in _source_items(conn, source.id):
        groups.setdefault(str(it["type"]), []).append(it)

    for type_key, items in groups.items():
        tregs = target_by_type.get(type_key, [])
        if type_key == CUSTOM_TYPE:
            # custom 不自动匹配：有同类型目标 → ②；无 → ③
            for it in items:
                free = [r for r in tregs if r.id not in occupied]
                if free:
                    candidates.append(
                        {
                            "source_region_id": it["source_region_id"],
                            "source_label": it["source_label"],
                            "block_id": it["block_id"],
                            "block_name": it["block_name"],
                            "options": [_option(r) for r in free],
                        }
                    )
                else:
                    unmatched.append(
                        {
                            "source_region_id": it["source_region_id"],
                            "source_label": it["source_label"],
                            "block_id": it["block_id"],
                            "block_name": it["block_name"],
                            "manual_options": [],  # 占位：apply 前统一补全
                        }
                    )
            continue
        if not tregs:
            # 目标无同类型区域 → ③（手动指定任意未占用区域或留空）
            for it in items:
                unmatched.append(
                    {
                        "source_region_id": it["source_region_id"],
                        "source_label": it["source_label"],
                        "block_id": it["block_id"],
                        "block_name": it["block_name"],
                        "manual_options": [],
                    }
                )
        elif len(items) >= len(tregs):
            # 源数 >= 目标数：按序自动匹配前 len(tregs) 个（D7）；源多出的进③
            for it, tr in zip(items, tregs, strict=False):
                occupied.add(tr.id)
                auto.append(
                    {
                        "source_region_id": it["source_region_id"],
                        "source_label": it["source_label"],
                        "target_region_id": tr.id,
                        "target_label": tr.label,
                        "block_id": it["block_id"],
                        "block_name": it["block_name"],
                    }
                )
            for it in items[len(tregs) :]:
                unmatched.append(
                    {
                        "source_region_id": it["source_region_id"],
                        "source_label": it["source_label"],
                        "block_id": it["block_id"],
                        "block_name": it["block_name"],
                        "manual_options": [],
                    }
                )
        elif len(items) > 0:
            # 目标同类型区域多于源：按序匹配是猜测 → ②多候选（按序者预选，用户点选）
            free = [r for r in tregs if r.id not in occupied]
            for it in items:  # 每个源绑定一行，候选 = 同类型全部未占用区域
                candidates.append(
                    {
                        "source_region_id": it["source_region_id"],
                        "source_label": it["source_label"],
                        "block_id": it["block_id"],
                        "block_name": it["block_name"],
                        "options": [_option(r) for r in free],
                    }
                )

    # ③ 手动指定候选 = 全部未被自动匹配占用的目标区域（任意类型）
    free_all = [
        _option(r) for r in _target_regions(conn, target_template_id) if r.id not in occupied
    ]
    for row in unmatched:
        row["manual_options"] = free_all

    return {
        "source_version_id": source.id,
        "source_version_name": source.name,
        "source_template_id": source.template_id,
        "target_template_id": target_template_id,
        "target_version_id": target_version.id,
        "auto": auto,
        "candidates": candidates,
        "unmatched": unmatched,
    }


def apply_migration(
    conn: sqlite3.Connection,
    source_version_id: int,
    target_template_id: int,
    pairs: list[tuple[int, int]],
) -> dict[str, object]:
    """落库最终映射：前端把三清单确认结果（① 全部 + ②③点选）整包提交。

    服务端按系统边界完整校验（区域归属/存活块/排除区域/不重复占用），
    不重放 plan 一致性——用户在清单里的每次调整都已是合法选择。
    """
    _source, target_version = _guard_pair(conn, source_version_id, target_template_id)

    seen_regions: set[int] = set()
    for region_id, block_id in pairs:
        if region_id in seen_regions:
            raise AppError(
                REGION_TEMPLATE_MISMATCH,
                f"区域（id={region_id}）在提交清单中重复",
                status_code=400,
            )
        seen_regions.add(region_id)
        region = regions_repo.get_region(conn, region_id)
        if region is None:
            raise AppError(REGION_NOT_FOUND, f"区域不存在（id={region_id}）", status_code=404)
        if region.template_id != target_template_id:
            raise AppError(
                REGION_TEMPLATE_MISMATCH,
                f"区域（id={region_id}）不属于目标模板（id={target_template_id}）",
                status_code=400,
            )
        if region.review_status == "excluded":
            raise AppError(
                REGION_EXCLUDED, f"区域（id={region_id}）已排除，不能绑定", status_code=400
            )
        if blocks_repo.get_block(conn, block_id) is None:
            raise AppError(
                BLOCK_NOT_FOUND, f"字符块不存在或已删除（id={block_id}）", status_code=404
            )
        bindings_repo.upsert_binding(conn, target_version.id, region_id, block_id)

    return {"version_id": target_version.id, "created": len(pairs)}
