"""Measure actual 1/5/10-page cold/warm previews in an isolated library."""

import hashlib
import json
import os
import statistics
import sys
import tempfile
import time
from io import BytesIO
from pathlib import Path


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="modudoc-benchmark-") as directory:
        os.environ["MODUDOC_DATA_DIR"] = directory
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
        import pymupdf
        from app.main import create_app
        from app.services.libreoffice import get_manager
        from docx import Document
        from fastapi.testclient import TestClient

        results = []
        with TestClient(create_app()) as client:
            for count in (1, 5, 10):
                document = Document()
                document.add_paragraph("姓名：{{姓名}}")
                for page in range(count):
                    if page:
                        document.add_page_break()
                    document.add_paragraph(f"第 {page + 1} 页 · 中文文档性能验收")
                    document.add_paragraph("项目经历与工作成果。保留文档样式、中文字体与分页。")
                source = BytesIO()
                document.save(source)
                started = time.perf_counter()
                response = client.post(
                    "/api/templates", files={"file": (f"{count}页.docx", source.getvalue())}
                )
                response.raise_for_status()
                parse_ms = (time.perf_counter() - started) * 1000
                template = response.json()
                version = template["default_version_id"]
                region = next(r for r in template["regions"] if r["placeholder"] is not None)
                block = client.post(
                    "/api/blocks", json={"name": "测试姓名", "content": "测试用户"}
                ).json()
                client.post(
                    f"/api/versions/{version}/bindings",
                    json={"region_id": region["id"], "block_id": block["id"]},
                ).raise_for_status()
                timings = []
                for _ in range(4):
                    started = time.perf_counter()
                    preview = client.get(f"/api/versions/{version}/preview")
                    preview.raise_for_status()
                    token = preview.headers["x-render-token"]
                    overlay = client.get(f"/api/versions/{version}/overlay?render_token={token}")
                    overlay.raise_for_status()
                    assert (
                        overlay.json()["pdf_sha256"] == hashlib.sha256(preview.content).hexdigest()
                    )
                    timings.append((time.perf_counter() - started) * 1000)
                with pymupdf.open(stream=preview.content, filetype="pdf") as pdf:
                    assert len(pdf) == count
                    assert all(any(value < 200 for value in p.get_pixmap().samples) for p in pdf)
                exported = client.post(
                    f"/api/versions/{version}/export", json={"confirm_large_overflow": True}
                )
                exported.raise_for_status()
                path = Path(directory) / f"export-{count}.docx"
                path.write_bytes(exported.content)
                assert get_manager().convert(path).read_bytes() == preview.content
                results.append(
                    {
                        "pages": count,
                        "parse_ms": round(parse_ms, 2),
                        "cold_preview_ms": round(timings[0], 2),
                        "warm_preview_median_ms": round(statistics.median(timings[1:]), 2),
                        "preview_export_equal": True,
                    }
                )
        print(
            json.dumps(
                {"samples": results, "scope": "synthetic Chinese documents; local machine"},
                ensure_ascii=False,
                indent=2,
            )
        )


if __name__ == "__main__":
    main()
