"""应用配置。所有可调参数集中在此，D4 阈值等开发期校准项走配置不改代码。"""

from pathlib import Path


class Settings:
    """全局配置。路径锚定 backend/ 目录，数据落在项目根 data/。"""

    # 服务
    host: str = "127.0.0.1"  # P10 铁律：只绑本机回环，禁止 0.0.0.0
    # 8740：避开常见开发端口（8000 曾被本机其他服务占用）
    port: int = 8740

    # 目录
    # config.py 在 backend/app/core/ 下，三层 parent 才到 backend/（M0 少算一层致 data 落错位）
    backend_root: Path = Path(__file__).resolve().parents[2]
    project_root: Path = backend_root.parent
    data_dir: Path = project_root / "data"
    templates_dir: Path = data_dir / "templates"
    db_path: Path = data_dir / "app.db"
    # 渲染管线（M4）：转换缓存与 LO 独立 profile（避开单实例锁，P8）
    render_cache_dir: Path = data_dir / "render_cache"
    lo_profile_dir: Path = data_dir / "lo_profile"
    # LO fontconfig（P17）：cask 版 LO 缺主字体配置，系统字体全不可见致中文空白
    fontconfig_dir: Path = data_dir / "fontconfig"

    # 溢出分级阈值（D4：超出区域原高度 50% 为界，开发期实测校准）
    overflow_threshold: float = 0.5

    # LibreOffice
    soffice_timeout_seconds: float = 30.0

    def ensure_dirs(self) -> None:
        """创建运行时目录（幂等）。"""
        self.templates_dir.mkdir(parents=True, exist_ok=True)
        self.render_cache_dir.mkdir(parents=True, exist_ok=True)
        self.lo_profile_dir.mkdir(parents=True, exist_ok=True)
        self.fontconfig_dir.mkdir(parents=True, exist_ok=True)


settings = Settings()
