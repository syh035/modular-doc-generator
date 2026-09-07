"""表行实体：每表一个 dataclass（frozen，行 → 对象由 from_row 完成）。

JSON 类字段（anchor / bbox_json）在实体层保持原始字符串，
结构化解析属于 service 层职责（M4/M5b 产生与消费）。
"""

import sqlite3
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class Block:
    id: int
    name: str
    content: str
    category: str
    created_at: str
    updated_at: str
    deleted_at: str | None  # 软删除标记（D11），NULL = 存活

    @classmethod
    def from_row(cls, row: sqlite3.Row) -> "Block":
        return cls(
            id=row["id"],
            name=row["name"],
            content=row["content"],
            category=row["category"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            deleted_at=row["deleted_at"],
        )


@dataclass(frozen=True, slots=True)
class Tag:
    id: int
    name: str
    created_at: str

    @classmethod
    def from_row(cls, row: sqlite3.Row) -> "Tag":
        return cls(id=row["id"], name=row["name"], created_at=row["created_at"])


@dataclass(frozen=True, slots=True)
class Template:
    id: int
    filename: str
    storage_name: str
    sha256: str
    status: str
    created_at: str
    updated_at: str

    @classmethod
    def from_row(cls, row: sqlite3.Row) -> "Template":
        return cls(
            id=row["id"],
            filename=row["filename"],
            storage_name=row["storage_name"],
            sha256=row["sha256"],
            status=row["status"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )


@dataclass(frozen=True, slots=True)
class Region:
    id: int
    template_id: int
    type: str
    label: str
    placeholder: str | None
    anchor: str  # 文档流锚点 JSON（P3：区域身份锚定）
    order_index: int
    bbox_json: str | None
    confidence: float | None
    review_status: str
    created_at: str
    updated_at: str

    @classmethod
    def from_row(cls, row: sqlite3.Row) -> "Region":
        return cls(
            id=row["id"],
            template_id=row["template_id"],
            type=row["type"],
            label=row["label"],
            placeholder=row["placeholder"],
            anchor=row["anchor"],
            order_index=row["order_index"],
            bbox_json=row["bbox_json"],
            confidence=row["confidence"],
            review_status=row["review_status"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )


@dataclass(frozen=True, slots=True)
class Version:
    id: int
    template_id: int
    name: str
    created_at: str
    updated_at: str

    @classmethod
    def from_row(cls, row: sqlite3.Row) -> "Version":
        return cls(
            id=row["id"],
            template_id=row["template_id"],
            name=row["name"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )


@dataclass(frozen=True, slots=True)
class Binding:
    id: int
    version_id: int
    region_id: int
    block_id: int
    status: str  # active / missing
    created_at: str
    updated_at: str

    @classmethod
    def from_row(cls, row: sqlite3.Row) -> "Binding":
        return cls(
            id=row["id"],
            version_id=row["version_id"],
            region_id=row["region_id"],
            block_id=row["block_id"],
            status=row["status"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )
