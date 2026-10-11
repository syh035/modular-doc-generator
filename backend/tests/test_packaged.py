"""Standalone configuration and resource hosting must not write into app resources."""

import json
import os
import subprocess
import sys
from pathlib import Path

from fastapi.testclient import TestClient
from pytest import MonkeyPatch

from app.core.config import settings
from app.main import create_app


def test_explicit_data_directory_in_fresh_process(tmp_path: Path) -> None:
    target = tmp_path / "user data"
    env = dict(os.environ, MODUDOC_DATA_DIR=str(target),
               PYTHONPATH=str(Path(__file__).resolve().parents[1]))
    result = subprocess.run(
        [sys.executable, "-c", "from app.core.config import settings; import json; "
         "settings.ensure_dirs(); print(json.dumps(str(settings.db_path)))"],
        env=env, cwd=tmp_path, capture_output=True, text=True, check=True,
    )
    assert Path(json.loads(result.stdout)) == target / "app.db"
    assert (target / "templates").is_dir()


def test_packaged_static_assets_and_api_coexist(
    tmp_path: Path, monkeypatch: MonkeyPatch, client: TestClient
) -> None:
    assets = tmp_path / "resources"
    assets.mkdir()
    (assets / "index.html").write_text("<h1>Packaged workbench</h1>")
    monkeypatch.setattr(settings, "static_dir", assets)
    client = TestClient(create_app())
    assert client.get("/").text == "<h1>Packaged workbench</h1>"
    assert client.get("/api/health").json()["application"] == "modular-doc-generator"
    assert client.get("/api/does-not-exist").status_code == 404
    assert client.get("/../app.db").status_code == 404
    assert sorted(p.name for p in assets.iterdir()) == ["index.html"]
