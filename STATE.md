# STATE.md — 会话状态摘要（累积写入，不新建）

## 2026-09-05 · M0 项目骨架会话（完结）

### 一句话快照

M0 完成并验收全绿；下一步 = 新会话执行 M1 数据层（TODO.md 第二项，依赖链 M0→M1→{M2,M3}）。

### 本次完成

- 后端：backend/（FastAPI 127.0.0.1:8740，/api/health 含 LibreOffice 探测、统一错误结构 AppError、ruff/mypy/pytest 全绿）
- 前端：frontend/（Vite+Vue3+TS+Pinia，双栏布局壳 4 组件，apiFetch 统一错误解析，RequestSequencer 实现 P7 过期响应丢弃，eslint/vue-tsc/vitest 全绿）
- scripts/dev.sh 一键启动（venv/依赖自检 + 端口预检查 + trap 清理）；浏览器冒烟 6/6 通过
- 首次提交 f35e32a（三件套+PRD 副本）；验收提交见 git log

### 接口契约（已落地）

- `GET /api/health` → `{"status":"ok","libreoffice":{"available":bool,"path","version","hint"}}`
- API 错误：`{"error": {"code": "...", "message": "..."}}`，错误码表在 backend/app/core/errors.py
- 前端 apiFetch 抛 ApiRequestError(code,message)；网络失败统一 NETWORK_ERROR 文案
- 后端端口 8740（P11：8000 被本机其他服务占用）；前端 5173 代理 /api → 8740

### 用户偏好（本次新明确）

- 无新增；沿用 D1–D13

### 环境事实

- 本机 python3.12 在 ~/.local/bin/python3.12（系统 python3 是 3.9，勿用）
- LibreOffice 未安装（M4 前需装：brew install --cask libreoffice）
- Node 24 / npm 11

### 变更原则（首次定下，后续仅在变更时追加变更项）

- 单渲染管线铁律：预览即管线 PDF，导出即管线 DOCX，禁止另建 HTML 预览路径
- 服务只绑 127.0.0.1；日志禁止打印简历内容
- 区域身份锚定文档流元素，不锚页面坐标
- 推翻 D1–D13 任何一项须先与用户确认
- 每模块完成判据：类型检查 + lint + 模块测试全绿

## 2026-09-05 · 需求分析会话（完结）

### 一句话快照

需求分析完成，用户确认方案 A 与全部决策（D1–D13，详见 AGENTS.md 决策表）；项目尚无代码；下一步 = 新会话执行 M0 项目骨架（TODO.md 顶部第一项）。

### 接口契约

尚无代码。已约定雏形（M0/M1 定稿）：

- API 错误结构：`{"error": {"code": "TEMPLATE_CORRUPT", "message": "..."}}`
- 区域类型枚举：name / contact / objective / education / work / project / skills / summary / custom
- 数据表：blocks / tags / block_tags / templates / regions / versions / bindings

### 用户偏好（本次新明确）

- 选型拍板：接受 LibreOffice 一次性安装依赖，换取单管线预览-导出一致性
- D11 落地口径：块软删除为必做，绑定一步撤销列加分项

### 变更原则（首次定下，后续仅在变更时追加变更项）

- 单渲染管线铁律：预览即管线 PDF，导出即管线 DOCX，禁止另建 HTML 预览路径
- 服务只绑 127.0.0.1；日志禁止打印简历内容
- 区域身份锚定文档流元素，不锚页面坐标
- 推翻 D1–D13 任何一项须先与用户确认
- 每模块完成判据：类型检查 + lint + 模块测试全绿
