"""模型层测试公共夹具：每测试独立内存库。"""

import sqlite3
from collections.abc import Iterator

import pytest

from app.models.db import get_conn, init_db


@pytest.fixture
def conn() -> Iterator[sqlite3.Connection]:
    """单连接内存库：同一事务语义下跑 repository（与生产 get_conn 用法一致）。"""
    with get_conn(":memory:") as c:
        init_db(c)
        yield c
