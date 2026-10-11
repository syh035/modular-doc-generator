"""Accept a moved resource bundle using a fresh offline venv and disposable user data."""

import argparse
import hashlib
import json
import os
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path


def accept(app: Path, python: Path, convert: bool) -> None:
    with tempfile.TemporaryDirectory(prefix="modudoc-packaged-") as directory:
        fixture = Path(directory)
        moved = fixture / "Moved App.app"
        shutil.copytree(app, moved, ignore=shutil.ignore_patterns("__pycache__"))
        resources = moved / "Contents/Resources"
        before = {p.relative_to(resources): hashlib.sha256(p.read_bytes()).hexdigest()
                  for p in resources.rglob("*") if p.is_file()}
        venv = fixture / "environment"
        subprocess.run([str(python), "-m", "venv", str(venv)], check=True)
        interpreter = venv / "bin/python"
        subprocess.run([str(interpreter), "-m", "pip", "install", "--no-index", "--find-links",
                        str(resources / "wheels"), "-r", str(resources / "requirements-release.txt")], check=True)
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        data = fixture / "User Data"
        env = dict(os.environ, MODUDOC_DATA_DIR=str(data),
                   MODUDOC_STATIC_DIR=str(resources / "frontend"),
                   PYTHONPATH=str(resources / "backend"), PYTHONDONTWRITEBYTECODE="1")
        # Deliberately launch from an unrelated directory; no source checkout cwd.
        log = (fixture / "service.log").open("w")
        process = subprocess.Popen([str(interpreter), "-m", "uvicorn", "app.main:app", "--host",
                                    "127.0.0.1", "--port", str(port)], cwd=fixture, env=env,
                                   stdout=log, stderr=log)
        base = f"http://127.0.0.1:{port}"
        try:
            for _ in range(100):
                try:
                    with urllib.request.urlopen(base + "/api/health", timeout=2) as response:
                        health = json.load(response)
                    break
                except OSError:
                    if process.poll() is not None:
                        raise RuntimeError((fixture / "service.log").read_text()) from None
                    time.sleep(0.1)
            else:
                raise RuntimeError("Packaged service did not become ready")
            assert health["data_fingerprint"] == hashlib.sha256(str(data.resolve()).encode()).hexdigest()
            with urllib.request.urlopen(base + "/", timeout=5) as response:
                assert "模块化文档生成助手" in response.read().decode()
            assert (data / "app.db").is_file()
            with urllib.request.urlopen(base + "/api/blocks", timeout=5) as response:
                assert json.load(response)["blocks"] == []
            if convert:
                request = urllib.request.Request(base + "/api/environment/check", method="POST")
                with urllib.request.urlopen(request, timeout=90) as response:
                    assert json.load(response)["conversion_ready"] is True
                with urllib.request.urlopen(base + "/api/guide/sample-template", timeout=10) as response:
                    docx = response.read()
                boundary = "modudoc-fixture"
                body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"sample.docx\"\r\n"
                        "Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document\r\n\r\n").encode() + docx + f"\r\n--{boundary}--\r\n".encode()
                request = urllib.request.Request(base + "/api/templates", data=body,
                    headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
                with urllib.request.urlopen(request, timeout=90) as response:
                    template = json.load(response)
                version = template["default_version_id"]
                with urllib.request.urlopen(base + f"/api/versions/{version}/preview", timeout=90) as response:
                    assert response.read().startswith(b"%PDF")
                request = urllib.request.Request(base + f"/api/versions/{version}/export", data=b'{"confirm_overflow":true}',
                                                  headers={"Content-Type": "application/json"})
                with urllib.request.urlopen(request, timeout=90) as response:
                    assert response.read().startswith(b"PK")
            after = {p.relative_to(resources): hashlib.sha256(p.read_bytes()).hexdigest()
                     for p in resources.rglob("*") if p.is_file()}
            assert before == after, "App resources were changed by execution"
            print("PASS: moved bundle, offline fresh venv, independent data, static workbench" +
                  (", real LO preview/export" if convert else ""))
        finally:
            process.terminate()
            process.wait(timeout=30)
            log.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path, required=True)
    parser.add_argument("--python", type=Path, required=True)
    parser.add_argument("--conversion", action="store_true")
    args = parser.parse_args()
    accept(args.app.resolve(), args.python.resolve(), args.conversion)


if __name__ == "__main__":
    main()
