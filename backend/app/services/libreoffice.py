"""LibreOffice headless 集成（D2 / P8）：探测 + DOCX→PDF 转换管理。

M4 转换策略：子进程 `soffice --convert-to`（独立 profile 避开单实例锁）
+ 全局串行锁 + 超时杀进程组 + 按输入内容 SHA-256 的转换缓存。
注：曾探测 UNO 常驻监听（--accept）方案，在本开发沙箱中监听进程
启动即永久挂起（0 CPU），无法验证，故留作后续优化路径（见 TODO.md）。
"""

import hashlib
import os
import shutil
import signal
import subprocess
import tempfile
import threading
from pathlib import Path

from app.core.config import settings
from app.core.errors import (
    LIBREOFFICE_UNAVAILABLE,
    RENDER_FAILED,
    RENDER_TIMEOUT,
    AppError,
)

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


class LibreOfficeManager:
    """DOCX→PDF 转换管理器（P8 落地）。

    - 串行锁：soffice 同 profile 并发转换会互相干扰，全局一次一条
    - 独立 profile：-env:UserInstallation 指向 data/lo_profile，
      与用户可能开着的 LibreOffice GUI（默认 profile）完全隔离
    - 超时回收：超时杀整个进程组（start_new_session 让子进程自成组长），
      并清空 profile（僵尸实例可能残留锁文件，宁可下次冷启动）
    - 转换缓存：以输入文件内容 SHA-256 为键，命中直接返回（预览/导出
      同源，未变内容零开销）
    """

    def __init__(
        self,
        soffice_path: str,
        *,
        profile_dir: Path,
        cache_dir: Path,
        timeout_seconds: float,
        fontconfig_file: Path | None = None,
    ) -> None:
        self.soffice_path = soffice_path
        self.profile_dir = profile_dir
        self.cache_dir = cache_dir
        self.timeout_seconds = timeout_seconds
        # P17：cask 版 LO 的 fontconfig 无主配置 → 系统字体（含全部 CJK）不可见
        # → 中文回退无字形内置字体渲染空白。设 FONTCONFIG_FILE 指向自产配置修复。
        self.fontconfig_file = fontconfig_file
        self._fontconfig_ready = False
        self._lock = threading.Lock()
        self.conversions = 0  # 实际执行 soffice 的次数（测试观测缓存命中用）

    def _ensure_fontconfig(self) -> None:
        """幂等写出 fontconfig 配置：扫描 macOS 系统字体目录（P17）。"""
        if self._fontconfig_ready:
            return
        conf = self.fontconfig_file
        assert conf is not None
        cache_dir = conf.parent / "cache"
        cache_dir.mkdir(parents=True, exist_ok=True)
        user_fonts = Path.home() / "Library" / "Fonts"
        conf.write_text(
            '<?xml version="1.0"?>\n'
            '<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">\n'
            "<fontconfig>\n"
            "  <dir>/System/Library/Fonts</dir>\n"
            "  <dir>/Library/Fonts</dir>\n"
            f"  <dir>{user_fonts}</dir>\n"
            f"  <cachedir>{cache_dir}</cachedir>\n"
            "</fontconfig>\n"
        )
        self._fontconfig_ready = True

    def _sha256(self, path: Path) -> str:
        h = hashlib.sha256()
        with path.open("rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        return h.hexdigest()

    def convert(self, input_path: Path) -> Path:
        """DOCX → PDF，返回缓存 PDF 路径（同内容重复转换零开销）。"""
        sha = self._sha256(input_path)
        cached = self.cache_dir / f"{sha}.pdf"
        if cached.is_file():
            return cached
        with self._lock:
            if cached.is_file():  # 双检：等锁期间别人可能已转完
                return cached
            self.profile_dir.mkdir(parents=True, exist_ok=True)
            (self.cache_dir / "tmp").mkdir(parents=True, exist_ok=True)
            workdir = Path(tempfile.mkdtemp(prefix="lo_", dir=self.cache_dir / "tmp"))
            try:
                pdf_path = self._run_soffice(input_path, workdir)
                cached.parent.mkdir(parents=True, exist_ok=True)
                pdf_path.replace(cached)  # 同缓存目录内原子移动
                self.conversions += 1
                return cached
            finally:
                shutil.rmtree(workdir, ignore_errors=True)

    def _run_soffice(self, input_path: Path, workdir: Path) -> Path:
        cmd = [
            self.soffice_path,
            "--headless",
            "--norestore",
            "--nologo",
            f"-env:UserInstallation={self.profile_dir.as_uri()}",
            "--convert-to",
            "pdf",
            "--outdir",
            str(workdir),
            str(input_path),
        ]
        # start_new_session：子进程自成进程组组长，超时可整组击杀
        env = dict(os.environ)
        if self.fontconfig_file is not None:
            self._ensure_fontconfig()
            env["FONTCONFIG_FILE"] = str(self.fontconfig_file)
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,
            env=env,
        )
        try:
            _, stderr = proc.communicate(timeout=self.timeout_seconds)
        except subprocess.TimeoutExpired:
            self._kill_group(proc)
            # 僵尸实例可能残留 profile 锁：清空宁可下次冷启动
            shutil.rmtree(self.profile_dir, ignore_errors=True)
            raise AppError(
                RENDER_TIMEOUT,
                f"LibreOffice 转换超时（>{self.timeout_seconds:.0f}s），已强制回收",
                status_code=500,
            ) from None
        # soffice 对部分失败也返回 0，必须以产物存在为准
        out = workdir / f"{input_path.stem}.pdf"
        if proc.returncode != 0 or not out.is_file():
            detail = (stderr or "").strip().splitlines()[-1] if stderr else ""
            raise AppError(
                RENDER_FAILED,
                "LibreOffice 转换失败" + (f"：{detail}" if detail else ""),
                status_code=500,
            )
        return out

    @staticmethod
    def _kill_group(proc: subprocess.Popen[str]) -> None:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.wait()


_manager: LibreOfficeManager | None = None


def get_manager() -> LibreOfficeManager:
    """进程级单例（懒加载）。测试可经 monkeypatch 替换 _manager 或直接构造实例。"""
    global _manager
    if _manager is None:
        soffice = find_soffice()
        if soffice is None:
            raise AppError(
                LIBREOFFICE_UNAVAILABLE,
                _MACOS_INSTALL_HINT,
                status_code=503,
            )
        _manager = LibreOfficeManager(
            soffice,
            profile_dir=settings.lo_profile_dir,
            cache_dir=settings.render_cache_dir,
            timeout_seconds=settings.soffice_timeout_seconds,
            fontconfig_file=settings.fontconfig_dir / "fonts.conf",
        )
    return _manager
