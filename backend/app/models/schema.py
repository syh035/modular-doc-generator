"""SQLite schema：七表 DDL。

设计要点：
- 时间戳一律 UTC ISO-8601 定长 TEXT（字典序即时间序），由应用层写入（见 db.utcnow）
- 状态类字段不加 CHECK 约束：枚举在应用层校验（core/constants.py），
  避免状态机演进（如 M3 需给模板加 failed 态）被 schema 钳制
- 删除策略：模板/版本/区域/标签物理删 + CASCADE 级联；块只软删除（D11），
  bindings.block_id 不带 ON DELETE（默认 RESTRICT）——物理删块必须先处理绑定，防悬空引用
- 区域身份锚定文档流元素（P3）：anchor 为锚点 JSON（段落/表格/单元格定位），
  bbox_json 仅承载页面坐标，供展示与测量
"""

DDL_STATEMENTS: tuple[str, ...] = (
    # ---- 字符块（内容资产）----
    """
    CREATE TABLE IF NOT EXISTS blocks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        content TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT '未分类',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT                -- 软删除标记（D11），NULL = 存活
    )
    """,
    # ---- 标签 ----
    """
    CREATE TABLE IF NOT EXISTS tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,     -- 重命名就地改，经联结表全库生效
        created_at TEXT NOT NULL
    )
    """,
    # ---- 块-标签联结 ----
    """
    CREATE TABLE IF NOT EXISTS block_tags (
        block_id INTEGER NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
        tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        PRIMARY KEY (block_id, tag_id)
    )
    """,
    # ---- 模板 ----
    """
    CREATE TABLE IF NOT EXISTS templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT NOT NULL,        -- 用户可见原文件名
        storage_name TEXT NOT NULL,    -- 落盘唯一名 {id}_{原文件名}，防同名覆盖
        sha256 CHAR(64) NOT NULL UNIQUE,  -- 内容指纹（D10 重传关联）
        status TEXT NOT NULL DEFAULT 'parsing',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )
    """,
    # ---- 可替换区域 ----
    """
    CREATE TABLE IF NOT EXISTS regions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        template_id INTEGER NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
        type TEXT NOT NULL,            -- 9 种区域类型，见 core/constants.py
        label TEXT NOT NULL,           -- 显示名（校对界面）
        placeholder TEXT,              -- 占位符原文，如 {{姓名}}
        anchor TEXT NOT NULL,          -- 文档流锚点 JSON（P3：身份锚定）
        order_index INTEGER NOT NULL,  -- 文档流出现顺序（D7 迁移匹配依据）
        bbox_json TEXT,                -- 页面坐标 JSON，仅展示与测量
        confidence REAL,               -- 解析置信度（M3b）
        review_status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_regions_template_order ON regions(template_id, order_index)",
    # ---- 内容版本（归属模板，同模板内命名唯一）----
    """
    CREATE TABLE IF NOT EXISTS versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        template_id INTEGER NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (template_id, name)     -- M8：同模板内重名拦截
    )
    """,
    # ---- 绑定（版本 × 区域 → 块）----
    """
    CREATE TABLE IF NOT EXISTS bindings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version_id INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
        region_id INTEGER NOT NULL REFERENCES regions(id) ON DELETE CASCADE,
        block_id INTEGER NOT NULL REFERENCES blocks(id),  -- 无 CASCADE：块走软删除
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (version_id, region_id)  -- 一区域一版本只绑一块（假设①，M1 用户确认）
    )
    """,
)
