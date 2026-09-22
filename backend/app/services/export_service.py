"""导出服务（M9，PRD 4.8 / D5）：成品 DOCX 落盘 + 大超出警示清单提取。

- 产物 = render_service.VersionRender.data（预览 PDF 同源 DOCX，单管线铁律，
  预览所见即导出所得）；本模块只负责文件名、落盘与警示提取，不另起渲染路径
- 文件名「简历-{版本名}-{日期}.docx」：版本名清洗文件系统非法字符，
  日期取本地时区 YYYYMMDD；同名（同版本同日重复导出）直接覆盖
- 大超出清单（D5）：level == "large"（含固定行高裁剪 clipped，P6）的区域；
  小超出不拦截——重排导出即默认行为，仅大超出需用户确认
- 写盘失败（磁盘满/权限/目录被占）→ EXPORT_WRITE_FAILED 可读报错，
  绝不静默（PRD 边界：非浏览器下载拦截导致的静默失败）
"""

import re
from datetime import datetime
from pathlib import Path

from app.core.config import settings
from app.core.errors import EXPORT_WRITE_FAILED, AppError

# 文件系统非法字符（macOS/Windows 取并集）+ 控制字符
_ILLEGAL = re.compile(r'[/\\:*?"<>|\x00-\x1f]')


def sanitize_filename_part(name: str) -> str:
    """版本名 → 文件名安全片段：非法字符换下划线、去首尾空白与点。"""
    cleaned = _ILLEGAL.sub("_", name).strip().strip(".")
    return cleaned or "未命名"


def export_file_name(version_name: str, now: datetime | None = None) -> str:
    """导出文件名：简历-{版本名}-{YYYYMMDD}.docx（日期本地时区）。"""
    stamp = (now or datetime.now()).strftime("%Y%m%d")
    return f"简历-{sanitize_filename_part(version_name)}-{stamp}.docx"


def extract_large_overflow_warnings(items: list[dict[str, object]]) -> list[dict[str, object]]:
    """从 overlay items 提取大超出警示清单（D5 确认弹层数据源）。"""
    warnings: list[dict[str, object]] = []
    for item in items:
        ov = item.get("overflow")
        if not isinstance(ov, dict) or ov.get("level") != "large":
            continue
        ratio = ov.get("ratio")
        warnings.append(
            {
                "region_id": item.get("id"),
                "label": item.get("label"),
                "ratio": ratio if isinstance(ratio, (int, float)) else None,
                "clipped": bool(ov.get("clipped")),
                "fixed_row": bool(ov.get("fixed_row")),
            }
        )
    return warnings


def write_export(data: bytes, file_name: str) -> Path:
    """成品 DOCX 落盘 data/exports/（同名覆盖），返回写入路径；失败可读报错。"""
    exports_dir = settings.exports_dir
    target = exports_dir / file_name
    try:
        exports_dir.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    except OSError as exc:
        raise AppError(
            EXPORT_WRITE_FAILED,
            f"导出文件写入失败（{target}）：{exc.strerror or exc}。请检查磁盘空间与目录权限后重试",
            status_code=500,
        ) from exc
    return target
