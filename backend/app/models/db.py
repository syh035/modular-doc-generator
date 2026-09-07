"""SQLite 连接管理与建库入口。

事务边界约定：repository 函数不自行 commit；
一个 get_conn() 块内的全部写操作同属一个事务（正常退出统一提交、异常统一回滚）。
「删块 → 绑定原子置 missing」（D11）依赖这一约定。
"""

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

from app.core.config import settings
from app.models.schema import DDL_STATEMENTS

# 定长格式：微秒恒 6 位，字典序 == 时间序，可直接在 SQL 中比较
_TS_FORMAT = "%Y-%m-%dT%H:%M:%S.%fZ"


def utcnow() -> str:
    """当前 UTC 时间戳（ISO-8601 Z 后缀，TEXT 存储）。"""
    return datetime.now(UTC).strftime(_TS_FORMAT)


@contextmanager
def get_conn(db_path: str | Path | None = None) -> Iterator[sqlite3.Connection]:
    """连接上下文管理器。

    - 默认落 settings.db_path；测试可传 ":memory:"（内存库）或临时文件路径
    - foreign_keys 每连接显式开启（SQLite 默认关闭，CASCADE/RESTRICT 依赖它）
    - WAL 仅对文件库生效（内存库自动忽略，无害）
    """
    target: str | Path = db_path if db_path is not None else settings.db_path
    conn = sqlite3.connect(target)
    try:
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        yield conn
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db(conn: sqlite3.Connection) -> None:
    """建表建索引（幂等，CREATE IF NOT EXISTS）。"""
    for ddl in DDL_STATEMENTS:
        conn.execute(ddl)
