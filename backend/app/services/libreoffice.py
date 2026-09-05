"""LibreOffice headless 检测（D2）。

M4 渲染管线的前置条件：soffice 可用。此处只做探测与指引，
进程管理（常驻/看门狗，P8）在 M4 实现。
"""

import shutil
import subprocess
from pathlib import Path

from app.core.config import settings

# macOS 下 LibreOffice 常见安装路径（soffice 通常不在 PATH 中）
_MACOS_SOFFICE_CANDIDATES = [
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    "/usr/local/bin/soffice",
]

_MACOS_INSTALL_HINT = (
    "未检测到 LibreOffice，渲染功能不可用。安装方式：brew install --cask libreoffice"
)


def find_soffice() -> str | None:
    """返回可用的 soffice 可执行文件路径；未安装返回 None。"""
    found = shutil.which("soffice")
    if found:
        return found
    for candidate in _MACOS_SOFFICE_CANDIDATES:
        if Path(candidate).is_file() and Path(candidate).exists():
            return candidate
    return None


def check_libreoffice() -> dict[str, object]:
    """探测 LibreOffice 可用性，供 /api/health 使用。

    返回示例：
        {"available": true, "path": "/usr/local/bin/soffice", "version": "24.8.2"}
    探测失败时 version 为 None，hint 给出安装指引。
    """
    path = find_soffice()
    if path is None:
        return {
            "available": False,
            "path": None,
            "version": None,
            "hint": _MACOS_INSTALL_HINT,
        }
    try:
        result = subprocess.run(
            [path, "--version"],
            capture_output=True,
            text=True,
            timeout=settings.soffice_timeout_seconds,
        )
        # 输出形如 "LibreOffice 26.8.0.3 bce0998..."，版本号取第 2 个词（末词是 commit hash）
        version = result.stdout.strip().split()[1] if result.returncode == 0 else None
    except (subprocess.TimeoutExpired, OSError):
        version = None
    return {"available": version is not None, "path": path, "version": version, "hint": None}
