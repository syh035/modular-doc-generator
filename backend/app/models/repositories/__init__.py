"""数据访问层：按表拆分的 repository 模块统一出口。"""

from app.models.repositories import bindings, blocks, regions, tags, templates, versions

__all__ = ["bindings", "blocks", "regions", "tags", "templates", "versions"]
