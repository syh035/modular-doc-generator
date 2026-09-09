"""模型层测试公共夹具：每测试独立内存库；API 测试独立临时环境。"""

import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core.config import settings
from app.main import create_app
from app.models.db import get_conn, init_db


@pytest.fixture
def conn() -> Iterator[sqlite3.Connection]:
    """单连接内存库：同一事务语义下跑 repository（与生产 get_conn 用法一致）。"""
    with get_conn(":memory:") as c:
        init_db(c)
        yield c


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    """隔离 API 环境：DB 与模板目录指向 tmp_path，应用工厂重新实例化。"""
    monkeypatch.setattr(settings, "db_path", tmp_path / "app.db")
    monkeypatch.setattr(settings, "templates_dir", tmp_path / "templates")
    with TestClient(create_app()) as c:
        yield c
