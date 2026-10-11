"""Migration is a copy, rejects occupied targets and validates source files."""

import hashlib
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts/migrate_data.py"


def source_library(directory: Path) -> Path:
    directory.mkdir()
    (directory / "templates").mkdir()
    content = b"synthetic docx bytes"
    (directory / "templates/1.docx").write_bytes(content)
    with sqlite3.connect(directory / "app.db") as conn:
        conn.execute("CREATE TABLE templates(storage_name TEXT,sha256 TEXT)")
        conn.execute(
            "INSERT INTO templates VALUES (?,?)",
            ("1.docx", hashlib.sha256(content).hexdigest()),
        )
    return directory


def run(source: Path, destination: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run([sys.executable, str(SCRIPT), str(source), str(destination)],
                          capture_output=True, text=True, check=False)


def test_copy_preserves_source_and_accepts_initialized_empty_target(tmp_path: Path) -> None:
    source = source_library(tmp_path / "old")
    before = (source / "app.db").read_bytes()
    target = tmp_path / "Data"
    target.mkdir()
    with sqlite3.connect(target / "app.db") as conn:
        conn.execute("CREATE TABLE templates(id INTEGER)")
    assert run(source, target).returncode == 0
    assert (source / "app.db").read_bytes() == before
    assert (target / "templates/1.docx").read_bytes() == (source / "templates/1.docx").read_bytes()
    assert len(list(tmp_path.glob("Data-before-import-*"))) == 1
    assert run(source, target).returncode != 0


@pytest.mark.parametrize("kind", ["missing", "fingerprint", "traversal", "occupied"])
def test_invalid_migration_never_changes_destination(tmp_path: Path, kind: str) -> None:
    source = source_library(tmp_path / "old")
    target = tmp_path / "Data"
    if kind == "missing":
        (source / "templates/1.docx").unlink()
    elif kind == "fingerprint":
        (source / "templates/1.docx").write_bytes(b"changed")
    elif kind == "traversal":
        with sqlite3.connect(source / "app.db") as conn:
            conn.execute("UPDATE templates SET storage_name='../outside'")
    else:
        target.mkdir()
        (target / "precious.txt").write_text("keep")
    assert run(source, target).returncode != 0
    if kind == "occupied":
        assert (target / "precious.txt").read_text() == "keep"
    else:
        assert not target.exists()
