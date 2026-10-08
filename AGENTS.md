# AGENTS.md — 模块化文档生成助手（本地 Word 文档内容资产管理器）

## 项目定位

跑在个人电脑上的 Word 文档内容资产管理器：个人文字内容（简历为主场景，任意 Word 文档皆可）沉淀为「字符块」内容资产库，任意 DOCX 模板上传解析出可替换区域，点选绑定、多版本组合，导出与模板样式一致的 DOCX。单机单人、无账号体系、数据全本地、零联网。

- 需求依据：[原始 PRD v1.0](docs/product/PRD.md)（2026-09-04 定稿；保留历史，不自动覆盖后续决策）
- 分析定案：2026-09-05 需求分析会话，用户确认方案 A 与全部决策项

## 已确认决策（D1–D13，各项确认时间以记录为准，推翻任一项须先与用户沟通）

| # | 决策项 | 结论 |
|---|--------|------|
| D1 | 技术栈 | Python FastAPI + LibreOffice headless + PyMuPDF + SQLite；Vue 3 + Vite + TS + Pinia + pdfjs-dist |
| D2 | LibreOffice 依赖 | 接受一次性安装（macOS: `brew install --cask libreoffice`），应用启动时检测并给出指引 |
| D3 | 模板解析策略 | `{{字段名}}` 占位符为确定性主路径；常见字段名词表启发式为辅；定位校对兜底 |
| D4 | 溢出分级阈值 | 超出区域原高度 50% 为界；做成可配置项，开发期实测校准 |
| D5 | 大超出时导出 | 默认重排导出 + 先弹警示清单由用户确认 |
| D6 | 页眉页脚/文本框 | v1 不纳入可替换范围；解析跳过；校对界面标注不可选 |
| D7 | 跨模板迁移匹配 | 同类型区域按文档流出现顺序匹配；多出绑定进「无匹配」清单，不自动丢弃 |
| D8 | 块内容上限 | 5000 字（多行纯文本，保留换行） |
| D9 | 换行渲染 | 默认换段；「软回车选项」为加分项 |
| D10 | 模板重传关联 | 按文件内容 SHA-256 指纹关联（必做） |
| D11 | 撤销能力 | 必做「块软删除」；「绑定一步撤销」为加分项 |
| D12 | 响应基线 | 绑定后预览局部刷新 ≤1s；10 页内模板解析 ≤5s；超基线给进度反馈 |
| D13 | 产品命名 | 「模块化文档生成助手」（2026-09-22 用户定；README/窗口标题/本文件落地替换为 v1.1 M11；目录名「简历助手」与导出文件名不动） |

## 文档维护

- 仓库记录实际实现、验证结果、已完成进展及必要规则，不按每轮讨论新增草案或过程记录。
- 未实施工作统一放入 [下期规划](docs/product/NEXT_PLAN.md)及 [任务池](TODO.md)，明确未完成状态；长期开发历史继续保留。

## 技术栈与架构铁律

### 单渲染管线（产品立身之本）

预览与导出共用同一条「DOCX 生成 → LibreOffice → PDF」管线：

- 预览 = 该管线产物 PDF 经 pdfjs-dist 展示
- 导出 = 同一 DOCX 落盘
- **禁止**另建 HTML/浏览器端渲染路径做预览（会引入肉眼可见差异，违反验收口径）

### 后端

- Python 3.11+（本机用 ~/.local/bin/python3.12 建 venv）/ FastAPI / uvicorn，**只绑 127.0.0.1:8740**（见陷阱 P10/P11）
- python-docx + lxml：OOXML 解析与替换生成
- LibreOffice headless `--convert-to` 子进程转换（独立 profile + 超时杀组 + sha256 转换缓存；UNO 常驻不可用，见 P16）
- PyMuPDF：PDF 文本坐标提取、区域高度测量
- SQLite（WAL 模式）；测试 pytest

### 前端

- TypeScript + Vite + Vue 3 + Pinia + pdfjs-dist；测试 Vitest；E2E Playwright

### 可借力的本地资源

- 本地 skill：`docx`（OOXML 结构知识）、`pdf`（PDF 处理）、`webapp-testing`（Playwright E2E）
- 开源借鉴：docxtemplater（占位符替换与 run 碎片处理思路）、python-docx、Reactive Resume（交互布局参考）
- 前端布局相关工作（布局/间距/响应式/视觉审查）优先使用合适的 skill/MCP；`trae-remote-official:web-app-development`（uicraft）可用且适用时优先采用。插件缺失或能力可替代时，使用现有工具和浏览器验证，说明替代方案与验证结果，不因单一插件缺失停止任务（2026-10-08 用户更新，替代 2026-09-22 的强制插件规则）。

## 当前目录职责

```text
modular-doc-generator/
├── README.md / AGENTS.md / TODO.md / CHANGELOG.md
├── docs/
│   ├── README.md               # 文档分类与权威来源
│   ├── product/                # 原始需求、下期规划
│   ├── architecture/           # 当前架构与后续设计
│   └── development/            # 协作、验证、经验和历史
├── backend/app/{api,services,models,core}/
├── backend/tests/
├── frontend/src/{api,components,stores,pdf,constants}/
├── scripts/                    # 开发启动、一致性与 E2E
└── .github/                    # CI 与 Issue 模板
```

`data/` 是忽略的运行数据，`STATE.md` 是忽略的本地交接；二者不替代版本化的产品或技术文档。

## 命名与约定

- 后端 snake_case；API RESTful：`/api/blocks`、`/api/templates`、`/api/templates/{id}/regions`、`/api/versions` 等
- 前端组件 PascalCase；store `useXxxStore`
- 数据表：blocks / tags / block_tags / templates / regions / versions / bindings（M1 定稿字段）
- 名称类用户输入字段（块名 / 版本名等）长度统一 **1–30 字符**（2026-09-21 用户定，M8 起生效）
- 区域类型枚举（后端英文标识，前端中文展示）：name / contact / objective / education / work / project / skills / summary / custom
- 时间戳 UTC 存储，前端本地时区展示

## 错误处理范式

- API 错误统一结构：`{"error": {"code": "TEMPLATE_CORRUPT", "message": "..."}}`；错误码大写下划线，M0 建 code 表
- 文件上传/解析入口按不可信输入处理：损坏 zip、加密、畸形 XML → 可读报错，绝不拖垮服务
- 日志**禁止**打印简历内容（隐私）
- 前端渲染请求带序号，丢弃过期响应（见陷阱 P7）

## 数据流模式

- 状态变更一律：前端 → API → SQLite 落库 → 返回 → 前端刷新；校对进度逐操作落库（支持中断续作）
- **区域身份锚定文档流元素**（段落/单元格），页面坐标仅用于展示与测量（见陷阱 P3）
- 绑定归属于内容版本；删块 → 相关绑定原子置 `missing` 态，导出留空并提示

## 已知陷阱入口

[P1—P27 技术陷阱与历史经验](docs/development/KNOWN_ISSUES.md)已独立保存，编号保持不变。修改相关功能前阅读对应记录；发现可复用经验时更新该文档。

## 工作流程与验证

执行 [开发协作与验证规范](docs/development/WORKFLOW.md)。任务状态见 [TODO.md](TODO.md)，产品规划见 [下期规划](docs/product/NEXT_PLAN.md)，当前实现见 [架构总览](docs/architecture/OVERVIEW.md)。
