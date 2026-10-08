# 技术陷阱与历史经验

本文件承接原 AGENTS.md 的 P1—P27 原始记录，编号及记录内容保留。它是经验索引，不是未解决缺陷清单；未解决问题进入 [任务池](../../TODO.md)。

## 当前状态备注

- P8 的常驻方案已由 P16 的独立 profile 子进程转换方案替代。
- P21 的初始生命周期缺口已在 M5b 处理：自动 bbox 依据 PDF 指纹失效重算，人工 bbox 受保护；仍应回归相关行为。
- P27 的手工 .app 方案已回退，当前使用一键启动.command；成熟桌面打包在 M25 中规划。
- 其余记录保留当时的问题、修复和注意事项，不代表所有问题在当前版本仍未解决。

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
| P26 | Vite 默认绑 `localhost`，本机解析为 **::1（IPv6）** → 用 `curl http://127.0.0.1:5173` 探活**永远失败**（服务明明已起），桌面启动器 180s 轮询超时误报"启动失败"（实锤）；后端显式绑 127.0.0.1:8740 不受影响，同环境 curl 8740 通、5173 不通即为该陷阱指纹 | 端口就绪检测一律用 `lsof -nP -iTCP:<port> -sTCP:LISTEN`（协议栈无关）；确需 HTTP 探测时探 `localhost` 或 `[::1]`；dev.sh 自动开浏览器已改 lsof（scripts/dev.sh） |
| P27 | 手搓 .app（bash 脚本作 CFBundleExecutable）双击启动时，launchd 派生进程对 `~/Documents` 写操作被 TCC **静默拒绝**（EPERM，无授权弹窗——脚本型 LSUIElement app 的弹窗归因不可靠），dev.sh 拉起即死 → 用户视角「双击没反应」；加 NSDocumentsFolderUsageDescription + ad-hoc 签名后弹窗仍不出现（实锤）；终端直跑正常是因继承终端授权 | 已回退为 `一键启动.command`（Terminal 上下文有授权，链路可靠）；.app 集成移入 TODO M25——须用 Platypus 等成熟方案生成正规 Mach-O stub，TCC 弹窗归因才与普通 app 一致；如再遇 .app 排障：`log show --predicate 'eventMessage CONTAINS "modudoc"'` 看 LAUNCH/CHECKIN/ExitStatus，进程拉起成功但无反应先查 TCC 写权限 |


## M12 补充

| # | 陷阱 | 规避 |
|---|------|------|
| P28 | 预览容器内的 absolute 遮罩只隔离局部鼠标操作，背景块库和状态栏仍可交互；仅改 fixed 也不能阻止键盘焦点穿透 | 使用原生 dialog.showModal() 隔离背景并覆盖全窗，统一 Esc、Tab 和焦点归还；迁移阶段切换需保留焦点。jsdom 不实现原生模态隔离，需运行 verify_modals.py 的真实浏览器检查（M12 六弹层、焦点与背景隔离回归已通过） |

新增经验请记录根因、触发条件、规避方法和验证依据；历史记录变更时保留替代关系。
