# 当前架构总览

本文描述当前实现；下一阶段安排见 [下期规划](../product/NEXT_PLAN.md)，现行约束见 [AGENTS](../../AGENTS.md)。

## 组件与目录

```mermaid
flowchart LR
    App[Swift AppKit 与 WKWebView] --> UI[Vue 工作台与 Pinia]
    UI --> Client[前端 API 客户端]
    Client --> API[FastAPI 路由]
    API --> Services[解析 校对 替换 渲染 迁移服务]
    Services --> Repositories[数据访问层]
    Repositories --> SQLite[SQLite WAL]
    Services --> Files[本地模板 缓存 导出文件]
    Services --> DOCX[同源 DOCX 产物]
    DOCX --> LO[LibreOffice 子进程]
    LO --> PDF[PDF]
    PDF --> UI
    DOCX --> Download[DOCX 导出]
```

下载 App 由后端在 `127.0.0.1:8740` 同时提供 API 和生产前端资源，原生窗口加载该地址。源码开发使用端口 5173 的 Vite，通过 `/api` 代理访问后端。

| 目录 | 现有职责 |
|------|----------|
| [backend/app/api](../../backend/app/api/) | 请求模型、路由、输入校验和响应 |
| [backend/app/services](../../backend/app/services/) | 模板解析、替换、渲染几何、溢出、校对、迁移与导出 |
| [backend/app/models](../../backend/app/models/) | 实体、SQLite schema、连接/事务及 repositories |
| [backend/app/core](../../backend/app/core/) | 路径/服务设置、领域常量和统一错误处理 |
| [frontend/src/api](../../frontend/src/api/) | API 请求与响应处理 |
| [frontend/src/stores](../../frontend/src/stores/) | 工作台、块库和预览状态 |
| [frontend/src/components](../../frontend/src/components/) | 块库、模板预览、校对、版本与导出交互 |
| [frontend/src/composables](../../frontend/src/composables/) | 共享弹层键盘与焦点生命周期 |
| [frontend/src/pdf](../../frontend/src/pdf/) | pdfjs 渲染及坐标换算 |

六类弹层使用原生 `dialog.showModal()` 进入浏览器顶层并隔离背景，遮罩覆盖全窗。[useModalEsc](../../frontend/src/composables/useModalEsc.ts) 统一处理 Esc、Tab 循环、动态内容的焦点保留及关闭后归还焦点；迁移关闭沿用跳过语义。块库分隔条支持鼠标和左右键调宽，沿用现有 store 的边界与持久化。

溢出清单在 StatusBar 展示，通过 locate 事件经 App 转发至 TemplatePreview 暴露的 jumpToRegion，保留滚页和 1.8 秒闪烁。状态栏固定高度，清单横向滚动。TemplateManager 模态管理面板集中管理模板和版本：浏览不切换文档，显式使用才触发 store 切换；模板快速选择与内容版本选择仍在工具条，视图缩放和图例另成一行。

BlockLibrary 与 BindingDialog 共用 matchesBlock 名称／正文／标签搜索。块库保留块编辑标签与已有数据，统一通过搜索查找；块库只按统一查询过滤，不叠加不可见的 activeTagId。兼容的标签 API 和 store 能力保留。BlockEditor 宽版弹窗处理新建／编辑，App 在 ≤900px 使用 BlockDrawer。整页／宽度缩放由 previewScale 计算，PDF 与覆盖层共用同一 scale 和 viewport，不改变单渲染管线。

块库与模板管理各自维护批量勾选；全选只覆盖可见列表，换筛选清除选择。删除逐项调用 API，成功项移出列表，失败项保留并提示；删除当前模板通过 store.removeTemplate 清空预览、版本、迁移与导出警示。

颜色集中定义在 [style.css](../../frontend/src/style.css) 的 :root，组件共用主色、状态、文本、背景、覆盖层和阴影等语义变量。

## 内容资产和持久化

[schema.py](../../backend/app/models/schema.py) 定义 `blocks / tags / block_tags / templates / regions / versions / bindings / template_blocks / template_candidate_scans / version_region_actions`。

- 块是独立于模板的多行纯文本资产，通过标签组织；删除采用软删除。
- 模板保存原文件路径、SHA-256 指纹和解析/校对状态；同内容重传关联已有模板。
- DELETE /api/templates/{id} 在 BEGIN IMMEDIATE 内检查有效绑定，有绑定返回 409 TEMPLATE_IN_USE；无绑定级联删区域、版本、绑定，并删除原件。提交失败恢复暂存原件；原件无法暂存返回 500 TEMPLATE_DELETE_FAILED 并回滚。字符块 API 与 D11 软删除契约不变。
- 区域属于模板，文档流 anchor 承担定位身份，bbox 供页面展示和测量。
- 版本属于模板；一个版本的一个区域至多绑定一个块，同一块可被多个区域或版本引用。
- 被引用块软删除后，相关绑定进入 missing 状态；渲染与导出按现行降级规则处理。
- 工作稿渲染读取当前块内容；冻结归档独立存储当时的 DOCX／PDF 字节、来源和校验信息。`archives` 不对来源模板或版本建立级联外键，原件删除、共享块修改及工作稿撤销不影响归档。归档只能读取、下载或显式删除，不提供修改内容接口。

[db.py](../../backend/app/models/db.py) 开启 WAL 与外键。一次 `get_conn()` 范围内的写入统一提交，异常回滚，repositories 不自行提交。现有迁移是幂等的轻量补列/删列，没有单独的版本化迁移框架。

## 模板、替换与渲染

1. [模板服务](../../backend/app/services/template_service.py) 校验、指纹关联、保存原件，编排候选解析和默认版本创建。
2. [解析器](../../backend/app/services/docx_parser.py) 遍历正文和表格内段落，按占位符、词表、成段正文产生候选；页眉页脚和文本框不是 v1 可替换范围。
3. [校对服务](../../backend/app/services/proofread_service.py) 处理候选、框选、微调和区域状态，逐操作落库。
4. [替换引擎](../../backend/app/services/replacement.py) 定位文档流元素，替换占位符片段或整段内容；跨 run 占位符、多行克隆、样式继承和路径重算已有处理。
5. [渲染编排](../../backend/app/services/render_service.py) 使用同一 DOCX 产物转换 PDF，并计算几何/溢出；[导出服务](../../backend/app/services/export_service.py) 保存同源 DOCX 和处理警示。

现有占位符支持段内替换；无占位符区域走整段替换路径。预览上的 bbox 框选并不等同于实现任意字符区间替换，这属于后续需要核对的能力边界。

[LibreOfficeManager](../../backend/app/services/libreoffice.py) 使用串行锁、独立 profile、超时回收和内容 SHA-256 缓存。替换后的 DOCX 序列化归一 ZIP 时间戳，保证未变内容可命中缓存。版本预览仍整份转换以保证重新分页；前端根据实际 PDF 页指纹复用未变页画布，详情见下方页级缓存说明。

自动 bbox 依据来源 PDF 指纹与 geometry_version 失效重算，人工 bbox 保护不覆盖。跨页 bbox 保留首框顶层字段并通过可选 fragments 保存各页框；定位回查未消费行以处理晚写表格块。PDF 内容流顺序不能直接视为阅读顺序。相关陷阱见 [技术经验](../development/KNOWN_ISSUES.md)。

## 接口与数据目录

请求/响应模型以 [API 路由源码](../../backend/app/api/) 为准。服务运行后可通过内部 `/docs` 查看 FastAPI 生成的接口说明；本文件不复制全部字段。

- 块与标签：`/api/blocks`、`/api/tags`。
- 模板及区域：`/api/templates`、`/api/templates/{id}/regions`、`/api/regions/{id}`。
- 版本与绑定：`/api/templates/{id}/versions`、`/api/versions/{id}/bindings`。
- 版本文字编辑：`POST /api/versions/{version_id}/regions/{region_id}/text`，请求 `{content, sync_block=false, expected_content?}`，返回绑定信息。`expected_content` 不一致返回 409 `REGION_TEXT_CONFLICT`；空白或超过 5000 字返回 400 `BLOCK_INVALID`，排除区域拒绝编辑。默认新建块并换绑当前版本，显式同步才更新共享原块，标签保留；写入在单个 `BEGIN IMMEDIATE` 事务内完成。版本 overlay 增加 `current_text`（占位符区域仅包含可替换部分），前端保存后刷新块库、标签与版本预览。
- 识别升级：非空正文／表格都生成候选，占位符优先、一个占位符段落不额外创建整段候选。`template_candidate_scans.revision=2`（全文补齐）／`3`（词表升级） 标记新上传或已升级模板，启动只补齐旧规则忽略的短句；不恢复旧长段落／占位符的人工删除，不覆盖人工状态／框／绑定。扫描只读原件；不可解析原件跳过并记录模板 id，不输出文档内容或阻断应用启动。
- 渲染与导出：模板/版本 preview、版本 overlay 和 export。
- 跨模板迁移：模板 migrate/plan 与 migrate/apply；按类型及顺序匹配，custom 需人工选择。

[config.py](../../backend/app/core/config.py) 通过 `MODUDOC_DATA_DIR` 指定数据目录；源码开发默认项目 `data/`，下载 App 使用 `~/Library/Application Support/ModularDocGenerator/Data`。该目录包含 SQLite、模板、缓存、导出、字体配置和 LO profile，备份需保留整个目录。`MODUDOC_STATIC_DIR` 指向 App 内的生产前端，应用资源只读。运行说明见 [应用指南](../../desktop/README.md)和[开发规范](../development/WORKFLOW.md)。

## 平台与后续边界

下载 App 支持 macOS 14+ 的 Apple Silicon 和 Intel。LibreOffice 字体配置在 macOS 使用本机字体目录，在 Linux 保留系统配置；后端 CI 在 Ubuntu 执行真实转换。Node 仅用于源码开发与构建，CI 使用 Node 22；用户端只需 Python 3.12 和 LibreOffice。Windows 外壳尚未实现。

当前已实现最多 50 步全局撤销／重做、版本段落删除、空行块与前后插入。结构化块、计算窗口、AI 和动态表格仍属后续范围。本文随实际实现更新，未开发能力不作为已有架构描述。

页级缓存：版本 overlay 附 PDF sha 与页指纹；LO 转换仍按整份成品 DOCX 缓存。page_cache 为实际 PDF 可见内容建立 32 份有界缓存，前端只复用未变页的已完成画布，覆盖层始终对应当前渲染。

预览响应附 `X-Render-Token`，覆盖层请求携带 `render_token` 读取同一批次的字节和区域，避免两次请求间发生编辑后图文错配。批次缓存最多 16 份／64 MiB，近期完整渲染结果最多 8 份／64 MiB（单份超限保留当前文档）；过期批次返回 `RENDER_BATCH_EXPIRED`，前端重新获取整批。

转换磁盘缓存键包含 DOCX 和字体／转换器环境身份，默认限制 512 MiB；单份超限保留当前产物。读出 PDF 字节前与清理共用锁，响应不再依赖发送期间仍存在的缓存路径。近期渲染键包括来源字节、区域／绑定／块状态、排版动作、环境和溢出阈值。

归档与资料库维护 API 分别位于 `api/archives.py`、`api/maintenance.py`。备份用 SQLite backup API 获取一致性库，ZIP 保存数据库、模板原件与 SHA-256 清单，归档字节包含在数据库内；缓存和临时导出可重建。备份压缩文件上限 256 MiB、解压内容上限 512 MiB。恢复先验证清单、数据库、外键、模板和归档校验值，再保留恢复前备份并替换，失败回滚；同一服务内资料库请求串行化，健康检查仍可响应。恢复后清空撤销与渲染批次。


[原生 AppKit 应用](../../desktop/README.md)通过 WKWebView 提供独立工作台窗口；代码、前端和离线依赖随 App，Python 3.12 与 LibreOffice 由环境检测引导安装。Foundation Process 启动一个 Python 后端，健康响应的 application、project_fingerprint 与 data_fingerprint 校验资源和数据身份后才复用已有服务。停止、退出及启动失败回滚只操作本实例拥有的进程；系统通知须主动授权。


template_blocks 为模板库成员关联，区别于版本区域绑定；新建块可在尚未绑定区域时属于模板，解绑不丢成员。旧 active 绑定幂等补齐，绑定／复制／迁移自动关联目标模板；共享加入复用相同 block_id，编辑仍沿用全局块语义。模板删除级联成员但保留块资产；关联表按依赖顺序纳入全局历史恢复。查询 `GET /api/blocks?template_id=...` 与创建可选 template_id 保持旧 API 默认，全局列表供显式共享弹窗使用。
