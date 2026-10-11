"""Conservative page fingerprints from the actual pipeline PDF, including resources.

Vector display fingerprints retain used glyph outlines/images/rotation. A pixel
guard covers features not represented in SVG; annotations use conservative bytes.
Content-addressed cache is bounded.
"""

import hashlib
import threading
from collections import OrderedDict
from pathlib import Path

import pymupdf

_lock = threading.Lock()
_cache: OrderedDict[str, tuple[str, ...]] = OrderedDict()
_LIMIT = 32


def page_fingerprints(pdf_path: Path) -> tuple[str, list[str]]:
    raw = pdf_path.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    with _lock:
        cached = _cache.get(digest)
        if cached is not None:
            _cache.move_to_end(digest)
            return digest, list(cached)
        hashes = []
        with pymupdf.open(stream=raw, filetype="pdf") as source:
            for index in range(len(source)):
                source_page = source[index]
                if source_page.first_annot is not None or source_page.first_widget is not None:
                    with pymupdf.open() as page:
                        page.insert_pdf(source, from_page=index, to_page=index)
                        normalized = page.tobytes(garbage=4, clean=True, no_new_id=True)
                else:
                    # Only used glyph outlines, not unused global font subset bytes.
                    vector = source_page.get_svg_image(text_as_path=True).encode()
                    pixels = source_page.get_pixmap(alpha=True)
                    normalized = vector + pixels.samples
                hashes.append(hashlib.sha256(normalized).hexdigest())
        _cache[digest] = tuple(hashes)
        if len(_cache) > _LIMIT:
            _cache.popitem(last=False)
    return digest, hashes
