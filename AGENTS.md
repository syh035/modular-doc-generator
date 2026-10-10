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
- M14 语义颜色统一定义在 [style.css](frontend/src/style.css) 的 :root，组件引用对应状态、文本、边框、背景与透明层变量；原有色值与透明度保持不变。

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

管理面板焦点归还、模板删除事务／原件回滚及批量删除后的标签刷新经验见同文档 P31—P33；批量操作失败项必须保留并展示原因，全选限定当前可见列表。

macOS 代理沙箱内 soffice 崩溃／无输出退出的排查与执行权限处理见 P34；导出测试需复用同一份源字节，避免 ZIP 时间戳偶发失败，见 P35。

页面边缘漏框、PDF 晚写表格块与跨页 fragments 的兼容定位见 P36；补选必须可操作，重新定位保留区域身份、绑定与其他页框，见 P37。

全文补齐必须保留区域身份并记录一次性扫描版本，避免重启恢复人工删除；版本文字微调默认隔离当前版本，共享块同步须显式选择，块与绑定同事务、原文冲突检查及占位符前缀规则见 P38—P39。

## 工作流程与验证

执行 [开发协作与验证规范](docs/development/WORKFLOW.md)。任务状态见 [TODO.md](TODO.md)，产品规划见 [下期规划](docs/product/NEXT_PLAN.md)，当前实现见 [架构总览](docs/architecture/OVERVIEW.md)。

2026-10-09 用户授权按 TODO 自主推进、排序和模块验收；每模块验证通过后继续，全部完成统一回报，不再逐模块确认。溢出测量精度与词表历史边界见 P40—P41。

版本段落删除、单元格合法空段、空行块转文字见 P42；删除／恢复归属版本，不修改区域身份与原件。

全局撤销的事务快照、派生几何排除与手工框保护见 P43；禁止开放任意数据库快照写入 API。

E2E 同秒 fixture 去重、全文候选及本地 CMap 资源见 P44。

页级缓存与字体子集误刷新、PDF sha 批次保护及取消后画布失效见 P45；预览继续使用 PDF.js。

原生服务所有权、回环 IPv6、真实项目路径和 FileProvider 签名注意事项见 P46；桌面应用不得按端口杀进程，也不得自动接管其他项目。

模板库成员与版本绑定区分、共享块身份及历史恢复依赖见 P47；新建未绑定块也归属当前模板，解绑不移出模板库。

独立窗口、关窗重开、WebKit 同名下载与原生编辑菜单快捷键见 P48；下一版本运行时打包不纳入 M28。

标签界面精简后的隐藏筛选与数据保留见 P49。

### P50 分发资源与运行数据隔离（M29）

分发应用必须设置 MODUDOC_DATA_DIR 与 MODUDOC_STATIC_DIR，不在 Resources 写数据库、缓存或 pyc；PYTHONDONTWRITEBYTECODE=1。复用健康身份同时校验资源与数据目录，macOS `/var` 与 `/private/var` 的真实路径须用 POSIX realpath 统一。Python 3.12 wheels 的平台标签须匹配最低 macOS 与架构，Intel PyMuPDF 不可用过旧的 10.13 标签。旧库复制迁移必须保留源目录和校验原模板指纹，非空目标拒绝覆盖。独立子进程测试必须显式设置 PYTHONPATH 与无关 cwd，避免仅在 backend 目录执行才通过。LibreOffice 探测需覆盖个人 Applications。

### P51 环境初始化退出保护（M29）

初始化依赖／迁移尚未拥有后端时也属于 busy；退出检查必须先判断 busy，再判断服务所有权，否则 ⌘Q 会让环境子进程失去宿主。
