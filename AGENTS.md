# AGENTS.md — 简历助手（本地简历编辑器，命名待定）

## 项目定位

跑在个人电脑上的简历内容资产管理器：职业经历沉淀为「字符块」内容资产库，任意 DOCX 模板上传解析出可替换区域，点选绑定、多版本组合，导出与模板样式一致的 DOCX。单机单人、无账号体系、数据全本地、零联网。

- 需求依据：《简历编辑器产品需求文档》v1.0（2026-09-04 定稿，原件在 `~/Desktop/简历编辑器产品需求文档.md`）
- 分析定案：2026-09-05 需求分析会话，用户确认方案 A 与全部决策项

## 已确认决策（D1–D13，2026-09-05 用户确认，推翻任一项须先与用户沟通）

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
| D13 | 产品命名 | 待定，用户定，不阻塞开发 |

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

## 目录结构（M0 落地时按此创建）

```
简历助手/
├── AGENTS.md / TODO.md / STATE.md
├── backend/
│   ├── app/
│   │   ├── main.py            # 入口，绑 127.0.0.1
│   │   ├── api/               # 路由层（薄）
│   │   ├── services/          # 业务逻辑：解析 / 渲染 / 替换 / 溢出 / 迁移
│   │   ├── models/            # SQLite schema + 数据访问
│   │   └── core/              # 配置、常量（区域类型枚举、错误码表）
│   ├── tests/
│   └── pyproject.toml
├── frontend/
│   ├── src/{api,components,stores}
│   └── package.json
├── data/                      # 运行时数据，gitignore
│   ├── app.db
│   └── templates/             # 模板原件
└── .gitignore                 # data/ node_modules/ dist/ __pycache__ 等
```

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

## 已知陷阱（开发前预判；修复 bug 后在此追加经验）

| # | 陷阱 | 规避 |
|---|------|------|
| P1 | Word 将 `{{姓名}}` 拆成多个 run（`{{姓` + `名}}`） | 段落内合并 run 文本后再匹配，禁止按 run 直读 |
| P2 | 预览/导出双路径导致样式差异 | 单管线铁律（见架构铁律节） |
| P3 | 多栏/浮动/嵌套表格致 PDF 坐标与文档流错位 | 区域身份锚定文档流元素，坐标仅展示与测量 |
| P4 | 克隆段落属性致编号错乱（1. 2. 2. 3.） | 克隆 pPr 时检测并剥离编号属性 |
| P5 | 区域内混合格式，继承歧义 | 继承区域首 run 属性（定稿规则） |
| P6 | 固定行高表格内大内容被裁剪 | 溢出检测需读行高设置，固定行高+大内容 → 提示用户 |
| P7 | 快速连续操作，旧渲染响应后到覆盖新结果 | 前端请求序号 + 丢弃过期响应 |
| P8 | soffice 冷启动慢 / 单实例锁 / 僵死进程 | 常驻进程 + 看门狗 + 超时回收 + 转换缓存 |
| P9 | 模板字体本机未装，渲染发生字体替换 | 口径说明：一致性指本产品预览 vs 导出，非 Word 原机效果 |
| P10 | 服务绑 0.0.0.0 把隐私数据暴露到局域网 | 铁律：只绑 127.0.0.1 |
| P11 | 本机常见端口（8000 等）可能被其他服务占用，uvicorn 绑定失败但脚本静默继续 | 后端固定用 8740；dev.sh 启动前 lsof 预检查端口，占用即报错退出 |
| P12 | `soffice --version` 输出为 "LibreOffice 26.8.0.3 <commit-hash>"，取末词会拿到 hash 而非版本号 | 版本号取输出第 2 个词（services/libreoffice.py） |
| P13 | config.py 位于 `backend/app/core/`，锚定 backend/ 需三层 parent；M0 少算一层致运行时数据落 `backend/data/`，且 `.gitignore` 无锚定 `data/` 模式把错位目录也忽略，git status 无法暴露（M1 发现并修复） | 路径锚定用 `Path(__file__).resolve().parents[N]` 并注释层级；数据目录位置以 `data/app.db` 实际落盘验证为准 |
| P14 | 外部同步工具会静默回滚/覆盖工作区文件（两次实锤：AGENTS.md 陷阱表被覆盖、M1 的 ruff 修复被回滚） | 改完文件尽快 git 提交；提交前 `git diff` 复核关键修改是否仍在；发现"修过的问题又出现"先怀疑同步回滚 |
| P15 | python-docx `cell.add_table()` 会在单元格尾部自动补一个空 `w:p`（OOXML 要求 `w:tc` 以段落结尾）——嵌套表格的文档流枚举会比直觉多一个空段 | 构造嵌套表格测试/校对预期时把尾空段算上；空段在几何匹配中天然跳过，但占 anchor 的 para_idx |
| P16 | LO UNO 常驻监听在本机环境挂起不可用（进程僵住 0 CPU，实测 M4）；且 soffice 默认共享 profile 有单实例锁 | 用 `--convert-to` 子进程 + `-env:UserInstallation` 独立 profile + 超时杀进程组 + sha256 内容寻址缓存（P8 的"常驻进程"方案以此修正落地，见 services/libreoffice.py） |
| P17 | homebrew cask 版 LO 用自带 fontconfig 枚举字体，但 app bundle 内**无主 fonts.conf** → 系统字体（含全部 CJK）不可见 → 中文回退到无字形的 Linux Libertine G 渲染**空白**（文本仍可提取！）；显式指定字体名也没用（解析不到） | soffice 子进程设 `FONTCONFIG_FILE` 指向自产配置（扫 /System/Library/Fonts 等，见 libreoffice.py `_ensure_fontconfig`）；验证 PDF 必须逐字符查渲染墨迹，**文本提取通过 ≠ 字形渲染正常**；fontconfig 冷缓存首次转换可能耗时数分钟（扫全系统字体），属一次性成本 |
| P18 | P17 修复后（真 CJK 字体生效），LO 写 PDF 内容流会把同一视觉行拆成乱序片段（「张/三的/简历」顺序错乱、同行 y 基线抖动 104.9~107.0），内容流序 ≠ 阅读序——几何对齐全数失配 | 块序仍可靠（= 文档流序）；块内按 y 重叠（≥50%）聚类成视觉行、行内按 x 排序（pdf_geometry.py `_visual_rows`）；不要假设内容流顺序即阅读顺序 |
| P19 | pdfjs-dist 6.x（及 5.7+）主线程与 worker bundle 均依赖 `Map.prototype.getOrInsert/getOrInsertComputed`（Map Upsert 提案，Chromium 136+ 才有）；内嵌/MCP 浏览器内核较旧时 `page.render` 抛 "getOrInsertComputed is not a function" → canvas 空白但 DOM/覆盖层正常（极易误判为渲染逻辑 bug） | 前端锁定 `pdfjs-dist@5.4.149`（exact pin，最后一个不用该 API 的版本）；5.4 与 6.x 渲染 API 兼容（`canvas` 参数/`PageViewport` 同构）；升级浏览器或 pdfjs 前先 grep `getOrInsert` 确认 |
| P20 | 运行中的 Vite dev server 在依赖版本变更后仍按 `node_modules/.vite` 旧预构建产物供给浏览器（报错堆栈指向 `pdfjs-dist.js` 而非源 mjs）——换依赖后硬刷新页面无效，复测仍复现旧错误 | 依赖变更后必须重启 dev server；注意 dev.sh trap 清理不彻底时先 `lsof -iTCP:8740/5173` 查残留并 kill 再启动 |
| P21 | bbox 是「首次渲染落库、非空不覆盖」（render_service._persist_region_bboxes）——P17 字体修复后清渲染缓存重转 PDF，**新布局下旧 bbox 静默存活**，前端黄框整体浮高 ~9pt（M5a 验收实锤；前端换算链路无辜，库值本身就是错的） | 已数据修复（bbox 置 NULL 触发重算）；「渲染产物变了但 bbox 不跟随」是设计缺口，bbox 生命周期策略（如缓存 miss 时失效）随 M5b 校对流程定夺；排查对齐问题先比对「库 bbox vs PyMuPDF 实测」再怀疑前端 |
| P22 | TemplatePreview 三重渲染竞态（M5a 验收实锤白板）：① store 时序 pdfData 先于 status=ready 置位，watcher 在 loading 态触发 rebuild，v-else 未渲染 DOM 无 canvas → render(undefined) 崩；② **seq 序号守卫只能拦「未开始」的任务，拦不住「在飞」的 page.render**——渲染中容器 resize 触发新 rebuild，新旧批次并发打同一 canvas 被 pdfjs 拒绝 → canvas 已设尺寸却全白；③ void rebuild() 异常未捕获无诊断线索 | rebuild 门控 status==='ready'（watch 源含 status，ready 后补渲染）；RenderedPage 持 RenderTask 句柄暴露 cancel()，每轮 rebuild 先取消上一批在飞渲染；openDocument 竞态孤儿文档显式 destroy；整体 try/catch 记 console.error；教训：**前端异步任务取消必须显式，序号守卫不是取消** |
| P23 | Vue 模板内渲染占位符字面量 `{{ '{{' }}xx{{ '}}' }}` 会被编译器按**首个 `}}`** 截断（插值定界符扫描不识别字符串字面量）→ eslint 报 parsing error，vite 构建同样挂（M2 会话实锤 GuidePage.vue） | 字面量定义在 script 常量、模板经变量插值渲染（如 `placeholderExample = '{{字段名}}'`）；任何含 `}}` 的字符串都不能出现在模板插值表达式内 |
| P24 | python-docx `doc.save()` 的 zip entry 时间戳取**当前时刻** → 同内容的成品 DOCX 每次字节不同 → LO 转换缓存（按内容 sha256 键）**永远 miss** → 每次预览/overlay 都全量跑 soffice（实测 4–72s 波动，D12 超标根因）；且 preview 与 overlay 两端点各自渲染、时间戳互异，串行转换两次（M3b 验收实锤：重复 preview 13.6s，cProfile 显示 16.2s 全在等 soffice 子进程） | 替换产物序列化做 zip 时间戳归一（replacement.py `_serialize_deterministic`，固定 (1980,1,1,0,0,0)）：同内容 → 同字节 → 缓存命中（重复 preview 0.036s、preview+overlay 双检吸收一次转换）；任何新增"生成 DOCX → 按内容寻址缓存"链路都必须先保证序列化确定性 |
| P25 | 渲染端点（/preview、/versions/{id}/preview）返回 FileResponse 带 ETag/Last-Modified 但**无 Cache-Control** → 浏览器启发式缓存判定响应"仍新鲜"（Heuristic freshness，基于 Last-Modified 距今时长的 10%）→ 绑定变更后前端 fetch 同一 URL **不发网络请求**直接复用旧 PDF →「替换了但预览没反应」（UI 调整②批验收实锤；后端 PDF 实测已正确替换，纯前端缓存复用）。此前未暴露是因为 P24 修复前每次响应都耗时 4–14s，掩盖了缓存命中路径 | 渲染产物 FileResponse 一律显式 `headers={"Cache-Control": "no-store"}`（两端点已修）；本地单机禁用浏览器缓存是安全的——转换成本由后端内容寻址缓存兜底（P24）；**凡"URL 不随内容变化"的动态产物响应，必须显式管控缓存头**；排查"操作了但界面没变"类问题先 curl -D 看响应缓存头，再怀疑前端渲染 |

## 验收测试流程约定（2026-09-18 用户定）

- 测试开始时：自动准备环境——先 `lsof -iTCP:8740/5173` 查残留进程并清理 → 起后端+前端 → curl /api/health 确认 → 用 MCP browser_use 打开页面执行测试；不等用户手动准备
- 测试完毕且用户确认后（即提交 git 时）：自动清理残存程序——kill 8740/5173 监听进程、删除临时测试文件（/tmp 脚本与产物）

## 完成判据

- 每模块：类型检查 + lint + 模块测试全绿
- v1 整体：三大场景 E2E（日常沉淀 / 定向投递 / 模板换装）+ 一致性专项（预览 PDF vs 导出重转 PDF 逐页 diff + 3–5 个真实模板人工比对）
