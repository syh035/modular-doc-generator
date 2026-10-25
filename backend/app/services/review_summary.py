"""Read-only inventory of DOCX objects outside the supported body paragraph flow."""

from io import BytesIO
from zipfile import ZipFile

from lxml import etree

_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def unsupported_objects(data: bytes) -> list[dict[str, str]]:
    items: list[dict[str, str]] = []
    with ZipFile(BytesIO(data)) as archive:
        for name in sorted(archive.namelist()):
            if name == "word/document.xml" or (
                name.startswith(("word/header", "word/footer")) and name.endswith(".xml")
            ):
                root = etree.fromstring(
                    archive.read(name), etree.XMLParser(resolve_entities=False, no_network=True)
                )
                if name != "word/document.xml":
                    # Only text nodes are content; avoid exposing formatting XML values.
                    text = "".join(t.text or "" for t in root.iter(f"{_W}t")).strip()
                    if text:
                        items.append(
                            {
                                "id": name,
                                "kind": "页眉" if "header" in name else "页脚",
                                "text": text,
                            }
                        )
                for index, box in enumerate(root.iter(f"{_W}txbxContent")):
                    text = "".join(t.text or "" for t in box.iter(f"{_W}t")).strip()
                    items.append(
                        {
                            "id": f"{name}#textbox-{index + 1}",
                            "kind": "文本框",
                            "text": text or "空文本框",
                        }
                    )
    return items
