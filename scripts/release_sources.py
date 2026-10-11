"""Collect pinned corresponding upstream source archives for the AGPL app release."""

import argparse
import hashlib
import shutil
import tempfile
import urllib.request
from pathlib import Path

SOURCES = {
    "pymupdf-1.28.2-source.tar.gz": (
        "https://files.pythonhosted.org/packages/a3/fb/b6761fa2d5266f2cdb24c3b91f4023070ab7848381417678e7a289a1d52a/pymupdf-1.28.2.tar.gz",
        "5e0be7908a715aa20333caddd73f1d6f01e4cd0c26e869fa2dd0b7f344da2249",
    ),
    "mupdf-1.28.2-source.tar.gz": (
        "https://mupdf.com/downloads/archive/mupdf-1.28.2-source.tar.gz",
        "44075a84e329db55b9bef5f342a70fd26d69e48ad1d33cb89d9664581c641156",
    ),
}


def collect(output: Path) -> None:
    output.mkdir(parents=True, exist_ok=True)
    for name, (url, digest) in SOURCES.items():
        target = output / name
        if target.exists():
            raise FileExistsError(target)
        with tempfile.TemporaryDirectory(prefix="modudoc-source-") as stage:
            download = Path(stage) / name
            with urllib.request.urlopen(url, timeout=120) as response, download.open("wb") as file:
                shutil.copyfileobj(response, file)
            if hashlib.sha256(download.read_bytes()).hexdigest() != digest:
                raise ValueError(f"Source checksum mismatch: {name}")
            shutil.copyfile(download, target)
        target.with_suffix(".gz.sha256").write_text(f"{digest}  {name}\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    collect(parser.parse_args().output)


if __name__ == "__main__":
    main()
