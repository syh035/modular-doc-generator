"""Bounded local undo journal. Snapshots stay on the server; no arbitrary row restore API."""

import asyncio
import copy
import hashlib
import json
import sqlite3
from dataclasses import dataclass
from typing import TypeAlias, cast

from app.core.errors import AppError
from app.models.db import get_conn

Value: TypeAlias = str | int | float | None
Snapshot: TypeAlias = dict[str, list[dict[str, Value]]]
# Dependency order, reversed for deletion. Templates/files are guards, never restored.
_TABLES = (
    "blocks",
    "tags",
    "regions",
    "versions",
    "block_tags",
    "template_blocks",
    "bindings",
    "version_region_actions",
)


def capture(conn: sqlite3.Connection) -> Snapshot:
    result: Snapshot = {}
    for table in (*_TABLES, "templates"):
        result[table] = [
            cast(dict[str, Value], dict(row))
            for row in conn.execute(f"SELECT * FROM {table} ORDER BY rowid")
        ]
    return result


def fingerprint(snapshot: Snapshot) -> str:
    state = copy.deepcopy(snapshot)
    for table, rows in state.items():
        for row in rows:
            row.pop("updated_at", None)
            if table == "templates":
                row.pop("status", None)
            if table == "regions" and row.get("bbox_source") != "manual":
                row["bbox_json"] = None
                row["bbox_pdf_sha"] = None
    return hashlib.sha256(
        json.dumps(state, sort_keys=True, ensure_ascii=False).encode()
    ).hexdigest()


@dataclass
class Command:
    label: str
    before: Snapshot
    after: Snapshot


class HistoryJournal:
    def __init__(self) -> None:
        self.lock = asyncio.Lock()
        self.undo_stack: list[Command] = []
        self.redo_stack: list[Command] = []

    def status(self) -> dict[str, object]:
        return {
            "supported": True,
            "undo_count": len(self.undo_stack),
            "redo_count": len(self.redo_stack),
            "undo_label": self.undo_stack[-1].label if self.undo_stack else "",
            "redo_label": self.redo_stack[-1].label if self.redo_stack else "",
        }

    def clear(self) -> dict[str, object]:
        self.undo_stack.clear()
        self.redo_stack.clear()
        return self.status()

    def record(self, label: str, before: Snapshot, after: Snapshot) -> None:
        if fingerprint(before) == fingerprint(after):
            return
        self.undo_stack.append(Command(label, before, after))
        del self.undo_stack[:-50]
        self.redo_stack.clear()

    def apply(self, redo: bool = False) -> dict[str, object]:
        source = self.redo_stack if redo else self.undo_stack
        target = self.undo_stack if redo else self.redo_stack
        if not source:
            return self.status()
        command = source[-1]
        expected = command.before if redo else command.after
        desired = command.after if redo else command.before
        with get_conn() as conn:
            conn.execute("BEGIN IMMEDIATE")
            current = capture(conn)
            if fingerprint(current) != fingerprint(expected):
                raise AppError(
                    "HISTORY_CONFLICT",
                    "数据已在其他操作中改变，请刷新并清空撤销记录",
                    status_code=409,
                )
            # Derivative automatic geometry is recomputed; manual frames are user data.
            for table in reversed(_TABLES):
                conn.execute(f"DELETE FROM {table}")
            for table in _TABLES:
                for original in desired[table]:
                    row = original.copy()
                    if table == "regions" and row.get("bbox_source") != "manual":
                        row["bbox_json"] = None
                        row["bbox_pdf_sha"] = None
                    columns = ",".join(row)
                    placeholders = ",".join("?" for _ in row)
                    conn.execute(
                        f"INSERT INTO {table} ({columns}) VALUES ({placeholders})",
                        list(row.values()),
                    )
        source.pop()
        target.append(command)
        return self.status()
