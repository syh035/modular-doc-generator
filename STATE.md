# STATE.md — 会话状态摘要（累积写入，不新建）

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
