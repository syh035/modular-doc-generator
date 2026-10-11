"""Copy a legacy library into an empty standalone data directory without changing the source."""

import argparse
import hashlib
import shutil
import sqlite3
import tempfile
import uuid
from pathlib import Path


def migrate(source: Path, destination: Path) -> None:
    source, destination = source.resolve(), destination.resolve()
    if source == destination or source in destination.parents or destination in source.parents:
        raise ValueError("Source and destination must be separate")
    database = source / "app.db"
    if not database.is_file():
        raise ValueError("Source app.db missing")
    if destination.exists():
        allowed = {"app.db", "app.db-wal", "app.db-shm", "templates", "exports", "render_cache", "lo_profile", "fontconfig"}
        if any(p.name not in allowed for p in destination.iterdir()):
            raise ValueError("Destination contains unrecognized files")
        if (destination / "app.db").exists():
            with sqlite3.connect(f"{(destination / 'app.db').as_uri()}?mode=ro", uri=True) as conn:
                tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                for table in ("blocks", "tags", "templates", "versions", "regions"):
                    if table in tables and conn.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0]:
                        raise ValueError("Destination already contains library data")
        for name in ("templates", "exports"):
            if (destination / name).exists() and any((destination / name).iterdir()):
                raise ValueError("Destination contains document files")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".modudoc-import-", dir=destination.parent) as temp:
        staged = Path(temp) / "Data"
        staged.mkdir()
        with (
            sqlite3.connect(f"{database.as_uri()}?mode=ro", uri=True) as src,
            sqlite3.connect(staged / "app.db") as target,
        ):
            src.backup(target)
            if target.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise ValueError("Source database corrupt")
            for storage_name, sha in target.execute("SELECT storage_name,sha256 FROM templates"):
                original = (source / "templates" / storage_name).resolve()
                if original.parent != (source / "templates").resolve():
                    raise ValueError("Unsafe template path")
                if hashlib.sha256(original.read_bytes()).hexdigest() != sha:
                    raise ValueError("Template fingerprint mismatch")
                (staged / "templates").mkdir(exist_ok=True)
                shutil.copyfile(original, staged / "templates" / storage_name)
        if (source / "exports").is_dir():
            shutil.copytree(source / "exports", staged / "exports", symlinks=False)
        backup = destination.parent / f"Data-before-import-{uuid.uuid4().hex}"
        if destination.exists():
            destination.rename(backup)
        try:
            staged.rename(destination)
        except OSError:
            if backup.exists():
                backup.rename(destination)
            raise


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    migrate(args.source, args.destination)
    print("Library copied successfully; source retained")


if __name__ == "__main__":
    main()
