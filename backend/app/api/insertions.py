"""Explicit insertion identities; legacy region routes and binding positions remain unchanged."""

from typing import Literal

from fastapi import APIRouter, Response
from pydantic import BaseModel

from app.models.db import get_conn
from app.services import insertions

router = APIRouter(prefix="/api")


class InsertionCreate(BaseModel):
    kind: Literal["region", "insertion"] = "region"
    id: int
    side: Literal["before", "after"]


class InsertionUpdate(BaseModel):
    content: str | None = None
    block_id: int | None = None
    unbind: bool = False
    line_break_mode: Literal["paragraph", "soft"] | None = None
    expected_content: str | None = None


@router.post("/versions/{version_id}/insertions", status_code=201)
def create(version_id: int, payload: InsertionCreate) -> dict[str, object]:
    with get_conn() as conn:
        conn.execute("BEGIN IMMEDIATE")
        return insertions.create(conn, version_id, payload.kind, payload.id, payload.side)


@router.put("/versions/{version_id}/insertions/{row_id}")
def update(version_id: int, row_id: int, payload: InsertionUpdate) -> dict[str, object]:
    with get_conn() as conn:
        conn.execute("BEGIN IMMEDIATE")
        return insertions.update(conn, version_id, row_id, **payload.model_dump())


@router.delete("/versions/{version_id}/insertions/{row_id}", status_code=204)
def delete(version_id: int, row_id: int) -> Response:
    with get_conn() as conn:
        insertions.require_row(conn, version_id, row_id)
        conn.execute("DELETE FROM document_insertions WHERE id=?", (row_id,))
    return Response(status_code=204)
