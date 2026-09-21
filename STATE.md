# STATE.md — 会话状态摘要（累积写入，不新建）

## 2026-09-21 · M7 溢出处理会话（浏览器验收通过，已提交）

### 一句话快照

M7 溢出处理交付并验收通过（高度对比分级 + P6 固定行高裁剪检测 + 状态条跳转）；下一步 = 里程碑 2 验收（素模板端到端：校对 → 绑定 → 溢出分级正确）或 M8 版本管理。

### 本次完成

- 后端 services/overflow.py（新建）：measure_overflow（ratio=(新高−原高)/原高，仅 >0.5 为 large，D4 边界确认；clipped 强制 large）/ detect_fixed_rows（w:trPr/w:trHeight hRule="exact"，P6）/ detect_clipped（块内容非空行归一化后不在成品 PDF 全文 → 裁剪）
- replacement.py：ReplacementOutcome 增 region_clone_paths（region_id → 多行克隆段落新 path 列表）——region_paths 只含首行，克隆行不计入会低估 ratio（验收期实修）
- render_service.render_version：有绑定且模板 bbox 缺失 → ensure_template_preview 补齐再重读区域；溢出测量范围 = 首行 + 克隆行几何并集（_region_extent，跨页虚拟 bbox 只保 y 向）；overlay items 增 overflow 字段
- 前端 TemplatePreview：溢出着色覆盖绑定绿框（橙=small/红=large 或 clipped）+ title（+N% / 固定行高裁剪提示）+ 底部固定状态条（overflow-bar，large 在前同级 ratio 降序）+ chip 点击跳转（scrollTo + 闪烁 1.8s）+ 校对模式不显示溢出（确认决策④）
- 验证：后端 ruff/mypy/pytest 194 绿（+15，含 2 个真实 LO 端到端：重排 large 与 exact 行裁剪）；前端 eslint/vue-tsc/vitest 100 绿（+4）
- 浏览器自动化验收（两轮 + MutationObserver 精确复核）：红/橙/绿框、title +289%、状态条「溢出区域 2 个（大超出 1）」+ 排序、chip 点击闪烁（Observer 捕获 large/small 各一次）、校对模式隐藏恢复、控制台零错误
- 跳转滚动定性：单页模板 fit-width 后预览容器 maxScroll≈3px（整页在视口内），scrollTo 无效果属正常，非 bug；闪烁兜底定位
- 测试遗留数据：模板 11（区域 27←块13 large / 28←块12 无溢出 / 29←块15 small）；块 13/14/15「M7长内容块/中内容块/两行块」残留可删

### 接口契约（M8/M9 直接消费）

- overlay（GET /api/versions/{id}/overlay）regions[].overflow：`{orig_height, new_height, ratio, level: "small"|"large", clipped: bool, fixed_row: bool} | null`；仅 active 绑定区域计算，未绑定/无绑定恒 null
- 分级口径：ratio > threshold（config.overflow_threshold=0.5）→ large；clipped=true 强制 large（内容已丢，最高警示）；orig_height 来自 regions.bbox（模板原文高度）
- ReplacementOutcome(data, region_paths, region_clone_paths) 三元组——M9 导出消费 data；溢出/几何消费后两者
- render_version 对「有绑定但模板 bbox 缺失」自动 ensure_template_preview（幂等，LO 内容缓存吸收）

### 用户偏好（本次新增）

- 无新增；沿用浏览器自动化验收 + AI 代提交惯例

### 变更原则（本次无变更，沿用既有）

## 2026-09-18 · M5b 校对完整会话（浏览器验收批 1–5 全 PASS，已提交 c2c3832）

### 一句话快照

M5b 校对完整交付并验收通过（含 P21 bbox 生命周期定案 + pendingCount Q4 口径修复）；下一步 = 新会话执行 M7 溢出处理（TODO.md 里程碑 2 区下一项）。

### 本次完成

- 后端：regions 表迁移（新增 bbox_pdf_sha/bbox_source 列）+ services/proofread_service.py + api/regions.py（POST 创建/PATCH 更新/DELETE；状态机 pending↔confirmed/excluded；全部候选处理完自动 ready；Q3 无候选直接 ready）
- **bbox 生命周期（P21 定案）**：bbox_pdf_sha 记渲染产物指纹，sha 不匹配且 bbox_source='auto' → 自动失效重算；bbox_source='manual'（人工框选/微调）永不覆盖
- 前端：StatusBar 校对模式开关 + TemplatePreview 校对着色（绿=高置信/黄=低置信/蓝=已确认/灰虚线=已排除）+ 拖拽框选新建（服务端 align_flow_to_lines 反解文档流 anchor；空框拦截 REGION_FRAME_EMPTY/跨段拦截 REGION_FRAME_MULTI）+ RegionNameDialog 命名弹层 + 8 手柄边界微调（Esc 取消）+ ProofreadPopover 操作浮层（确认/排除/重新校对/微调/删除）+ 删除级联清绑定
- 验收期修复：pendingCount 与 regionsOf 的 Q4 口径对齐（excluded 不计入「待校对」统计；浏览器实测待校对 4→3 与可见框一致）
- 验证：后端 ruff/mypy/pytest 180 绿；前端 eslint/vue-tsc/vitest 96 绿；浏览器自动化验收批 1–5 全 PASS（状态流转/框选新建/空框跨段拦截/零位移防误触/微调几何精确/Esc 取消/删除级联/模板 11+12 自动 ready/正常模式回归/console 无功能错误）
- 测试遗留数据：模板 11/12 均 ready；块「临时块M5b」残留（绑定已级联清空，可随时删）

### 接口契约（M7/M8/M9/M10 直接消费）

- POST /api/templates/{tid}/regions（框选新建：bbox+label+type）→ 201；PATCH /api/regions/{id}（review_status/bbox/type/label）→ 200；DELETE /api/regions/{id} → 204
- 新错误码：REGION_FRAME_EMPTY(400) / REGION_FRAME_MULTI(400)；excluded 区域拒绑
- Region 新字段：bbox_pdf_sha（渲染产物指纹）/ bbox_source（auto|manual）
- 前端 proofreadMode 切换 = 渲染路径切换（模板预览字节 ↔ 版本渲染字节），overlay 响应 regions 含 review_status/bbox_source

### 用户偏好（本次新增）

- 无新增；沿用浏览器自动化验收 + AI 代提交惯例

### 变更原则（本次新增）

- 手动测试步骤口径修正：素模板 ≠ 0 候选——长正文段（≥30 字）以 custom/0.4 成段落兜底候选（模板 B 实测 2 候选属设计内行为）；「0 候选→直接 ready」仅短文本模板触发（后端单测覆盖）

## 2026-09-18 · UI 调整②批+③批追加 + P25 缓存修复会话（浏览器验收通过，已提交）

### 一句话快照

块库抽屉体验完整化 + 分类功能彻底移除 + P25 缓存修复交付；下一步 = 新会话执行 M5b 校对完整（TODO.md 里程碑 2 区下一项，含 bbox 生命周期策略定夺）。

### 本次完成

- ②批：抽屉宽度拖拽（230–360 + localStorage 记忆，下限经头部实测校准 260→230）；折叠按钮矩形内置竖线（头部新建右侧 / 收起态工具条最左）；卡片 2 行截断
- ③批追加（用户连续反馈）：**分类功能彻底移除**（blocks.category 列 DROP + 启动迁移 _migrate + 前后端全清，列表平铺按更新时间倒序）；无引用标签自动清理（tags.prune_orphan_tags，删块/替换标签同事务）；标签栏单行横滚 + 整体收起 + 折叠态关键字搜索框（匹配标签名→过滤块）；标签管理两行式（标题+N个块在上/编辑框在下，230px 无重叠）；块编辑就地展开（卡片内下方，字段带标题，新建表单同步加标题）；绿点迁 StatusBar 左下（绿点+文字组合）；工具条左组紧凑布局（toolbar-left 修 space-between 分散问题）；图例容器查询 ≤620px 隐藏；idle 提示删除
- **P25 缓存修复**：渲染端点 FileResponse 无 Cache-Control → 浏览器启发式缓存复用旧 PDF（绑定后"替换无反应"，后端 PDF 实测已正确替换）→ 两端点加 no-store
- 验证：后端 ruff/mypy/pytest 169 绿；前端 vue-tsc/eslint/vitest 84 绿（+StatusBar spec 3）；浏览器自动化 7/7+4/4+3/3+3/3

### 接口契约（变更，M5b/M8 直接消费）

- **Block 结构变更**：`category` 字段已删（前后端+schema），现为 `{id,name,content,tags,created_at,updated_at}`；块列表 GET /api/blocks 按更新时间倒序
- 标签生命周期：无任何存活块引用的标签自动删除（删块/PUT tags 整组替换后 prune）；GET /api/tags 不再出现 0 引用标签
- 渲染端点（/api/templates/{id}/preview、/api/versions/{id}/preview）响应带 `Cache-Control: no-store`（P25）——前端同 URL 重取永远真实请求
- 前端 blocks store：createNewBlock(name,content,tags)（3 参，category 已删）；groupedBlocks/categories 已删；新块插入列表头部（倒序语义）

### 用户偏好（本次新增）

- UI 迭代粒度小而快：一条反馈一次修复一验收；编辑类表单一律"字段标题在上、输入框在下"
- 空间布局敏感：会抠"重叠/间距/按钮位置"，容器查询隐藏优于换行挤压

### 变更原则（本次新增）

- 分类功能（M2 交付物）经用户确认整体移除——后续不再有"未分类"概念；无引用标签自动删除同理

## 2026-09-18 · M3b 解析完整 + 预览性能修复会话（验收 7/7 通过，已提交）

### 一句话快照

M3b 解析完整交付并验收通过（含 P24 预览性能根因修复）；下一步 = 新会话执行 M5b 校对完整（TODO.md 里程碑 2 区下一项，含 bbox 生命周期策略定夺）。

### 本次完成

- M3b 三层解析（docx_parser.parse_candidates）：占位符（confidence 1.0，label 过词表推断 type，决策 C）→ 词表段（标题=0.9 / "字段名："labeled=0.7）→ 成段正文（≥30 字=0.4）；同段不重复建区域；regions 落库带 type/confidence（M1 预留列，无 schema 变更）
- D10 指纹关联：同 sha256 重传 409 → 200 关联已有模板（响应带 reused 标记，首传 201）；TEMPLATE_ALREADY_EXISTS 错误码退役
- 纯图片模板：正文无任何文本层 → 400 TEMPLATE_IMAGE_ONLY（新错误码，走失败清残）；有文本无占位符照旧进待校对
- 整段替换（replacement.py，决策 A）：无占位符区域整段替换（首 run 样式继承 P5 / 多行克隆 P4 剥编号），同段混合时占位符优先；修复空 placeholder 命中 `full.find("")` 产生怪异插入的隐患
- **P24 预览性能根因修复**：python-docx save 的 zip entry 时间戳取当前时刻 → 成品 DOCX 字节漂移 → LO sha 缓存永 miss → 每次预览全量 soffice 转换（4–72s，且 preview/overlay 串行双转换）；replacement.py `_serialize_deterministic` zip 时间戳归一后：重复 preview 13.6s→0.036s，overlay 0.047s，双请求一次转换
- 验证：后端 ruff/mypy/pytest 166 绿（+28，含 field_lexicon/候选解析/指纹关联/整段替换/真实 LO 端到端）；前端 74 绿零改动（置信度着色 UI 留 M5b）
- 浏览器自动化验收 7/7（TRAE-browseruse）：三层解析落库/指纹关联/纯图片 400/覆盖层黄框（3 候选、过短段"张三"无框=反向边界用例）/词表区域绑定黄转绿/整段替换预览（"教育背景"→块内容）/控制台无功能错误

### 接口契约（M5b/M8/M9 直接消费）

- POST /api/templates → 首传 201 `{template, reused:false}`；同内容重传 200 `{template, reused:true}`（关联已有模板及其版本/区域）
- Region 增语义字段：`confidence` REAL（1.0 占位符 / 0.9 词表标题 / 0.7 labeled / 0.4 成段）+ `review_status`（现默认 pending，M5b 启用 confirmed/excluded）
- 新错误码：TEMPLATE_IMAGE_ONLY(400)；新服务模块 services/field_lexicon.py（词表常量可扩充，加分项）
- replacement.apply_replacements 产物为确定性字节（P24）——后续任何"DOCX→内容寻址缓存"链路必须保持序列化确定性

### 用户偏好（本次新增）

- 验收方式：调用 TRAE-browseruse skill 界面内浏览器自动检测（用户指令"调用skill，界面内浏览器自动检测"），替代人工点测
- 对界面上"预期外文字"敏感（验收中追问"张三"来源）——测试数据的设计意图要在交付说明里预先标注

### 变更原则（本次新增）

- 同 sha256 重传行为变更（409→200 关联）系 D10 定稿口径落地，M3a 时代的 409 契约废止

## 2026-09-18 · M2 块库 + UI 调整三点会话（代码+门禁全绿，待用户手动验收）

### 一句话快照

M2 + UI 三点 + 里程碑 1 验收打勾完成；下一步 = 用户手动验收 → AI 代提交 → 新会话执行 M3b 解析完整或 M5b 校对完整（TODO.md 里程碑 2 区）。

### 本次完成

- 后端 M2：/api/tags（GET 计数含 alive 块 / PUT 重命名撞名即合并返回目标标签 / DELETE 204）+ blocks API 完整化（POST/GET 增 `tags:[{id,name}]`、GET/PUT/DELETE /api/blocks/{id}，PUT 部分更新且 tags 字段=整组替换，DELETE 软删→绑定原子置 missing、重复删 404）+ GET /api/guide/sample-template（python-docx 现生成示例模板，显式 eastAsia 中文字体防 P17）
- 前端 UI 三点：① TopBar tab 化（工作台/模板制作指南）+ GuidePage.vue（写法说明+可复制示例段落+下载示例模板）；② BlockLibrary 抽屉化（左缘按钮控制 libraryOpen，默认展开；分组列表 zh 排序未分类殿后、标签筛选 chips、一表两用新建/编辑、内联删除二次确认、标签管理面板）；③ 模板下拉从顶栏挪进 TemplatePreview 工具条（idle 态可选），TopBar 不再有模板选择与版本 span（版本 UI 留 M8 入工具条）
- 验证：后端 ruff ✓ / mypy 32 文件 ✓ / pytest 138 绿（+23）；前端 eslint ✓ / vue-tsc ✓ / vitest 74 绿（+19：TopBar 重写 5 + GuidePage 3 + 工具条下拉 3 + blocks/app store 扩充）
- 本会话实锤缺陷（均已修）：① preview store 漏导出 `refreshVersionRender`（BlockLibrary 删块后刷新会 undefined 调用）；② blocks store `renameExistingTag` 成功时误返回标签名（契约=成功返回 null，组件按 null 判成功）；③ **P23**：Vue 模板内 `{{ '}}' }}` 字面量按首个 `}}` 截断（GuidePage 已改 script 常量插值，陷阱入 AGENTS.md）
- 测试陷阱：jsdom 下 `mockResolvedValue(Response.json(...))` 复用同一 Response 实例——组件挂载即 loadBlocks+loadTags 两次 fetch，第二次读已消费 body 报 "Body is unusable" 且经 store.error 渲染进页面文本；stub 须用 mockImplementation 每次新建 Response 并按 URL 分路由（含 /api/tags）

### 接口契约（M3b/M5b/M8/M9 直接消费）

- GET /api/tags → `{tags:[{id,name,block_count}]}`（block_count 只数未软删块；**tags 按名排序**，断言用集合勿比顺序）；PUT /api/tags/{id} `{name}` → 200 TagInfo（新名撞已有标签=合并，返回目标标签 id）；DELETE /api/tags/{id} → 204
- Block 结构（前后端一致）：`{id,name,content,category,tags:[{id,name}],created_at,updated_at}`；PUT /api/blocks/{id} 部分更新，`tags` 传什么整组替换为什么；DELETE → 204（软删，二次调用 404）
- GET /api/guide/sample-template → 200 docx（Content-Disposition attachment；仅前端下载链接消费）
- 新错误码：TAG_INVALID(400) / TAG_NOT_FOUND(404)
- 前端：app store 增 `activeTab: 'workbench'|'guide'` + setTab；blocks store 增 `libraryOpen/activeTagId/toggleTagFilter/filteredBlocks/groupedBlocks/updateExistingBlock/removeBlock/renameExistingTag→null|errMsg/removeTag`

### 用户偏好（本次新增）

- 无新增，沿用既有（里程碑 1 验收项经用户确认按 M6a 验收口径直接打勾）

### 变更原则（本次无变更，沿用既有）

## 2026-09-10 · M6a 绑定与替换引擎会话（自动化验收 6/6 全 PASS，待用户最终确认提交）

### 一句话快照

M6a 代码 + 自动化验收测试完成（浏览器实测 6/6 PASS）；下一步 = 用户最终确认 → AI 代提交 → 新会话执行里程碑 1 整体验收或 M2 块库完整（TODO.md 顶部）。

### 本次完成

- 后端替换引擎 services/replacement.py：`apply_replacements(template_data, regions, block_contents) → ReplacementOutcome(data, region_paths)`——P1 段内合并 run 定位占位符区间、新文本由覆盖 run 承载（P5 首覆盖 run 样式继承）；D9 多行内容首行留位 + 后续行克隆段落链式追加（P4 剥离 numPr）；替换后重新枚举文档流得 region→新 path 映射（多行克隆推挤后续索引）；同段多占位符两阶段：克隆行按文档序先收集（文本未动定位准）、文本替换逆序执行（texts 跟随更新防陈旧覆盖）
- render_service.render_version(version_id)：替换 → 成品 DOCX 临时文件（uuid 防并发）→ LO sha 缓存转换 → 成品文档流↔PDF 几何对齐；**替换后 bbox 现算入响应不落库**（P21「渲染产物变了 bbox 不跟随」缺口就此规避，模板 bbox 落库策略仍留 M5b）；missing 态绑定保留占位符原文
- 模板上传即建默认版本（template_service，versions 表 name="默认版本"）；M3a 前的存量模板无版本 → 前端回退模板预览（binding 恒 null）
- API：POST/GET /api/blocks（最小块 API，名称 2–30/内容 ≤5000/非空校验，BLOCK_INVALID）；POST /api/versions/{id}/bindings（upsert 换绑 200）、GET bindings、DELETE /bindings/{region_id}（204）、GET /versions/{id}/preview、GET /versions/{id}/overlay；绑定校验链：版本/区域/块存在性 + 区域归属模板（REGION_TEMPLATE_MISMATCH）
- 前端：api/{blocks,versions}.ts；stores/blocks.ts（loadBlocks/createNewBlock/selectBlock 点选切换）；stores/preview.ts 版本化——selectTemplate 走 default_version_id 的版本 preview+overlay（无版本回退模板预览）、bindRegionToBlock/unbindRegionFromBlock → refreshVersionRender 局部刷新；BlockLibrary.vue（新建表单+列表+点选高亮+正向绑定提示）、BindingDialog.vue（反向绑定/换绑/解绑浮层）、TemplatePreview.vue 覆盖层可点（绿=已绑定/黄=未绑定）；client.ts 补 204 处理
- 验证：后端 ruff ✓ / mypy 29 文件 ✓ / pytest 115 绿（+29：replacement 14 + blocks API 7 + versions API 8）；前端 eslint ✓ / vue-tsc ✓ / vitest 55 绿（+27：blocks store 5 + preview store 11 + BlockLibrary 5 + BindingDialog 6）
- 测试陷阱两则：① @vue/test-utils 传 `createPinia()` 插件会另建实例——组件 store 与测试 `useBlocksStore()` 不同源，直接赋值无效；不传插件则组件回落 activePinia 同源；② `Response.json(body, {method})`——method 非 ResponseInit 合法属性（TS2353），Response 构造器同理
- 验收期自动化测试（2026-09-18，browser_use 子代理，模板 9 m6a_accept.docx）：6/6 PASS——选模板 3 覆盖层/建块/正向绑定（PDF 首行渲染「张三」）/换绑三行文本块（渲染为 3 行独立段落）/浮层解绑（恢复 {{占位符}}）/全程无 P22 白屏；另定性一条控制台噪音（解绑 204 经 Vite 代理 → Chromium 记 ERR_ABORTED，JS 层正常 resolve、UI 正确，属 cosmetic，已记 TODO）
- 验收期决策与改动（用户确认）：① 7 个存量模板（M6a 前上传、无版本）整体删除——DB 级联 + 落盘 docx + 对应 sha 缓存；② ERR_ABORTED 仅记 TODO 不修；③ 新建块自动选中（blocks store createNewBlock 置 selectedBlockId=block.id，+1 断言，vitest 55 绿）
- 验收留痕数据：模板 9（m6a_accept.docx，3 占位符）+ 默认版本 1 + 块「姓名块/评价块」+ 姓名区绑定 active；渲染缓存内不可归属的版本渲染残留 PDF 未清理（可再生，无碍）

### 接口契约（M8/M9/M5b 直接消费）

- POST /api/blocks → 201 `{id,name,content,category,created_at,updated_at}`；GET /api/blocks → `{blocks:[...]}`
- POST /api/versions/{vid}/bindings `{region_id,block_id}` → 200 `{version_id,region_id,block_id,block_name,status:"active",created_at,updated_at}`（换绑幂等 200）；DELETE /api/versions/{vid}/bindings/{region_id} → 204
- GET /api/versions/{vid}/preview → 200 application/pdf（替换后成品）；GET /api/versions/{vid}/overlay → `{version_id, regions:[{...region 字段, bbox(现算，可 null), binding:{block_id,block_name,status}|null}]}`
- 新错误码：BLOCK_INVALID(400)/BLOCK_NOT_FOUND(404)/VERSION_NOT_FOUND(404)/REGION_NOT_FOUND(404)/REGION_TEMPLATE_MISMATCH(400)/BINDING_NOT_FOUND(404)
- ReplacementOutcome.region_paths：region_id → 成品文档流首行 path（overlay 几何对齐入口）；M9 导出直接复用 apply_replacements 产物 data 落盘
- 前端 overlay 消费：preview store refreshVersionRender 拉新 overlay，regions 整组替换（P7 共用选择序号）

### 用户偏好（本次新增）

- 验收可用浏览器自动化（MCP browser_use 子代理）代替人工点测（2026-09-18 用户主动要求）；自动化结论与直觉冲突时先查数据库/实测数据再下结论

### 变更原则（本次无变更，沿用既有）

## 2026-09-09 · M5a 预览只读会话（代码+自验完成，待用户手动验收）

### 一句话快照

M5a 完成待验收；下一步 = 用户浏览器手动验收 → AI 代提交 → 新会话执行 M6a 绑定与替换引擎（TODO.md 顶部）。

### 本次完成

- 前端 pdfjs 预览：`src/pdf/viewer.ts`（worker 走 Vite URL 导入、`openDocument` 返回 `{document, destroy}` 句柄——pdfjs 6.x destroy 在 loadingTask 上、data 先 slice 拷贝防 detach、`preparePage` 一次 viewport 供 canvas 绘制与覆盖层同源、dpr 高清渲染）
- 覆盖层几何：`src/pdf/geometry.ts` 纯函数——`bboxToOverlayRect`（后端 bbox 原点左上 → pdfjs 用户空间左下：y_user = viewBox[3] − y，再 convertToViewportPoint，任意 rotation 正确）；`overlayKind` 三态（M5a 无绑定数据恒黄/虚线，'bound' 分支留 M6a）
- 状态：`src/stores/preview.ts`——模板列表 + selectTemplate 状态机 idle→loading→ready|error；**取数顺序：PDF 先行**（首次触发 LO 转换与 bbox 落库），详情随后取到的 regions 已带 bbox；P7 一次选择共用一个序号（PDF/blob/详情三段手工 isCurrent 检查，非 sequencedFetch 逐请求加一）
- 组件：TemplatePreview.vue（空态/加载态含 D12 首转提示/error/页容器 fit-width 自适应 ResizeObserver/黄色覆盖层/未定位区域虚线徽标列表+图例统计）；TopBar.vue 模板下拉（挂载即 loadTemplates，上传按钮仍 disabled 属模板管理 UI 后续模块）
- 后端技术债清理：RequestValidationError handler → 422 统一 `{"error":{"code":"VALIDATION_ERROR","message":"请求参数校验失败：…"}}`（backend/app/core/errors.py + main.py 注册 + 测试）
- **验收期修复（P19/P20）**：MCP 浏览器内核 < Chromium 136，pdfjs-dist 6.3.289 的 `Map.getOrInsertComputed` 不存在 → `page.render` 抛错、canvas 空白（DOM/覆盖层正常，极具迷惑性）。降级锁定 `pdfjs-dist@5.4.149`（exact，最后一个不用该 API 的版本；5.4 与 6.x 渲染 API 同构，代码零改动）；依赖变更后必须重启 vite dev server（旧预构建缓存不失效，报错堆栈指向 `pdfjs-dist.js` 可辨认）
- 验证：后端 ruff ✓ / mypy 26 文件 ✓ / pytest 86 绿（新增 422 一条）；前端 eslint ✓ / vue-tsc ✓ / vitest 26 绿（新增 21：geometry 6 + store 7 + TemplatePreview 5 + TopBar 3）；MCP 浏览器端到端 8/8 PASS（canvas 墨迹 2468 非白像素/中文截图可见/覆盖框对齐「手机号」「教育经历」/P7 竞态/缓存秒开/无阻断错误）
- **验收追加修复（用户反馈黄框未对齐→数字定位三连）**：① P21 陈旧 bbox——库值系 P17 字体修复前坏字体渲染算出（bbox 非空不覆盖设计缺口），数据修复（置 NULL 重算，14 区域全部重算，干跑+PyMuPDF 实测+浏览器三点闭合）；② P22 渲染竞态白板——TemplatePreview 三缺陷（loading 态无 canvas 崩/在飞渲染不取消致并发 page.render 被拒/异常未捕获），修复为 status 门控 + RenderedPage.cancel()（RenderTask 句柄）+ try/catch；③ vitest 26→28 绿（+2 回归：loading 不渲染、重排取消旧批）；终验 6/6 PASS（框位置 14.52%/14.73%/13.63% vs 预期 14.53%/14.72%/13.63%，框内墨迹 436/577 像素，连切三模板无白板，控制台零报错）

### 接口契约（M6a/M5b 直接消费）

- 前端取数三 API：`listTemplates()/fetchTemplate(id)/previewUrl(id)`（src/api/templates.ts）；`fetchBlob/sequencedFetchBlob`（src/api/client.ts）
- 覆盖层换算契约：`bboxToOverlayRect(bbox, viewport.viewBox)`——viewport 必须与 canvas 绘制同源（preparePage 返回的实例）
- jsdom 测试事实：`new Response(jsdom的Blob)` 会静默字符串化为 `[object Blob]`（13 字节）；二进制 stub 必须用 `ArrayBuffer` 构造 Response
- pdfjs-dist 事实（**锁定 5.4.149**，P19）：RenderParameters 用 `canvas` 参数（5.4 起已支持，canvasContext 仅为兼容保留）；PageViewport 无 convertToViewportRectangle（用 convertToViewportPoint）；PDFDocumentProxy 无 destroy（在 loadingTask 上，openDocument 返回 `{document, destroy}` 句柄）；升级 pdfjs 前先 grep `getOrInsert` 确认内核兼容性
- 422 契约：所有 FastAPI 参数校验错误 → `{"error":{"code":"VALIDATION_ERROR","message":"请求参数校验失败：[...]"}}`

### 用户偏好（本次无新增，沿用）

### 变更原则（本次无变更，沿用既有）

## 2026-09-09 · M4 渲染管线会话（代码+自验完成，待用户手动验收）

### 一句话快照

M4 完成待验收；下一步 = 用户 curl 验收 → AI 代提交 → 新会话执行 M5a 预览只读（TODO.md 顶部，pdfjs 渲染 + 区域覆盖层）。

### 本次完成

- services/libreoffice.py：LibreOfficeManager——`soffice --convert-to` 子进程模式（UNO 常驻在本机挂起不可用，P16）+ `-env:UserInstallation` 独立 profile（规避单实例锁）+ 进程级序列化锁 + 超时杀进程组 + profile 清理 + sha256 内容寻址转换缓存（data/render_cache/）
- services/pdf_geometry.py：PyMuPDF 行提取（页序×内容流序）+ 归一化（连字展开/软连字符剔除/空白剔除）+ 文档流段落↔PDF 行顺序对齐（折行并集 bbox、LOOKAHEAD 跳页眉页脚污染行、未匹配保持 None）
- services/render_service.py：编排（转换→几何→bbox 落库，幂等；已有 bbox 不覆盖，留 M5b 校对维护）；全局渲染锁防并发重复落库
- api/templates.py：GET /api/templates/{id}/preview（FileResponse 直出管线 PDF，单管线铁律）
- docx_parser 增 iter_flow_paragraphs：文档流全序枚举，解析与几何匹配同源（锚点单一事实源）；config 增 render_cache_dir / lo_profile_dir
- 验证：ruff ✓ / mypy 26 文件（app，历史门禁口径）✓ / pytest 85 绿（新增 21：LO 管理 5 含真实集成 + 几何 9 + API 预览 4 含端到端 + flow 3）/ 真机冒烟 ✓（首转 15.5s 冷启动 → 缓存 0.026s、bbox 落库、二次产物逐字节一致）
- 修复：test_pdf_geometry 误访问 RegionGeometry.y1/x0（无此属性，改 bbox 下标）；test_docx_parser 嵌套表格期望漏算 python-docx 自动补的尾空段（P15）
- 验收期追加修复（P17/P18，详见陷阱表与下方字体事实）：① LO fontconfig 无主配置致中文渲染空白 → `FONTCONFIG_FILE` 注入 + data/fontconfig/ 自产配置；② 真 CJK 字体下内容流行序乱 → `_visual_rows` 视觉行聚类；③ 清空 render_cache 坏产物。P14 同步回滚在本模块 4 次实锤（含单独吞 _run_soffice 的 env 块），重要修改必须 inspect 级验证后尽快提交

### 接口契约（M5a/M9 直接消费）

- GET /api/templates/{id}/preview → 200 application/pdf（管线产物本体）；TEMPLATE_NOT_FOUND(404)；LIBREOFFICE_UNAVAILABLE(503)；RENDER_FAILED(500)；RENDER_TIMEOUT(504)
- **LO 字体事实（M4 验收实锤）**：docx run 无 rFonts（python-docx 默认模板行为）→ CJK 回退到 Linux Libertine G（无中文字形）→ **中文渲染空白但文本可提取**；显式 eastAsia 任意字体（含 mac 没有的宋体/等线/微软雅黑）→ LO 正确替换到系统 CJK 字体，渲染正常。真实 Word 模板样式表必带 eastAsia，不受影响；python-docx 造测试/演示文档必须显式设 eastAsia（含 run.font.name + rFonts eastAsia 双设置）。**验证 PDF 必须查墨迹（渲染像素），文本提取通过≠字形渲染正常**
- regions.bbox 落库结构：`{page(0基), x0, y0, x1, y1}`，PDF 点、原点左上、round 2 位；bbox=null=渲染未匹配（M5b 校对人工兜底），前端覆盖层按 null 画虚线框
- LibreOfficeManager.convert(docx_path) → Path（data/render_cache/{sha256}.pdf）；get_manager() 单例；M9 导出复用同一 manager 与缓存
- iter_flow_paragraphs(data: bytes) → Iterator[(anchor, 段落全文)]，anchor 编码与 parse_placeholders 完全一致（含空段落全序枚举）
- align_flow_to_lines(flow, pdf_lines) → {path 元组: RegionGeometry(page, bbox, line_count)}；空段/未匹配段不出现在结果
- 性能口径：D12「预览刷新 ≤1s」以缓存路径达成（0.026s）；首次渲染冷启动 ~15s（LO profile 冷启动+转换），属一次性成本，M5a 前端需加载进度反馈（D12 超基线给进度）

### 用户偏好（本次新增）

- 手动测试步骤给纯命令版本（zsh 粘贴带 # 的块会错乱）；人工验证通过后由 AI 代为 git 提交
- **trae-preview 浏览器控制台粘贴长命令会被损坏**（嵌套引号文本被替换成历史命令，M4 验收实锤两次：422/404 JSON 落成 .pdf 引发"PDF 损坏"误报）——后续手动验收步骤要么单条短命令、要么先落脚本文件让用户 `bash xx.sh` 执行，并让用户优先用系统终端
- 教训：curl -o 不校验 HTTP 状态码，错误 JSON 会静默存成目标文件；后续验收命令加 `head -c4 | grep %PDF` 魔数校验再打开

### 变更原则（本次无变更，沿用既有）

## 2026-09-09 · M3a 模板上传与解析会话（完结，用户验收通过）

### 一句话快照

M3a 完结（手动验收 8/8，四假设全部确认）；下一步 = 新会话执行 M4 渲染管线（TODO.md 顶部，soffice 常驻 + DOCX→PDF + 坐标提取 + 转换缓存）。

### 本次完成

- services/docx_parser.py：`{{字段名}}` 占位符解析——P1 段落内合并 run 后再匹配；D6 只扫 body 段落+表格单元格（含嵌套表格），页眉页脚/文本框天然排除；P3 anchor 记文档流路径
- services/template_service.py：校验链（.docx 白名单 / OLE 魔数→TEMPLATE_ENCRYPTED / 非 zip→TEMPLATE_CORRUPT / zip 缺 document.xml→TEMPLATE_CORRUPT）→ 建档 parsing → 落盘 `{id}_{原名}` → 解析 → 区域落库 → pending_review；失败清残（事务回滚 + 落盘文件删除）
- api/templates.py：POST /api/templates（multipart）、GET /api/templates（列表+regions_count）、GET /api/templates/{id}（详情+regions）、GET /api/templates/{id}/regions
- regions repo 补 count_regions；pyproject 增 python-multipart 依赖（FastAPI 文件上传必需）；mypy ignore 列表加 lxml
- 验证：ruff ✓ / mypy 24 文件 ✓ / pytest 64 绿（新增 32：parser 9 + service 11 + API 12）/ 真实启动冒烟 ✓（跨 run 合并、409 重复、四类错误、列表详情 404）

### 接口契约（M4/M6a 直接消费）

- anchor.path 编码（docx_parser.parse_placeholders 文档字符串为准）：段落 `[block]`；单元格段落 `[tbl, row, cell, para]`；嵌套表格每深一层追加三元组，末位恒为 para。kind: "p"（len==1）/ "cell_p"。重放：body 直接子元素按序计数 → w:tr → w:tc → 格内 w:p / 嵌套 w:tbl 各自独立计数
- 占位符 regex：`\{\{\s*([^{}]+?)\s*\}\}`，label=trim 后字段名，placeholder=原文；同段多占位符逐个出区域；order_index 文档流全局递增
- POST /api/templates → 201 `{id, filename, storage_name, sha256, status:"pending_review", created_at, updated_at, regions:[{..., anchor:object, bbox:null, confidence:null}]}`（列表不带 regions 带 regions_count）
- 新错误码：TEMPLATE_ALREADY_EXISTS(409)、TEMPLATE_NOT_FOUND(404)
- 状态机：parsing（建档瞬间态）→ pending_review（解析完成，同步）；ready 触发在 M5b；同 sha256 重复上传直接 409 拒绝（重传关联迁移属 M3b）
- 占位符区域 type 恒为 "custom"（词表启发式属 M3b）

### 用户偏好（本次新明确）

- 四假设已验收确认（2026-09-09）：①同 sha256 重复→409 拒绝 ②占位符 type=custom ③解析同步+失败无残留、无占位符模板也进待校对 ④纯后端 curl 验收即可
- 手动测试步骤给纯命令版本：带 # 注释的多行块不能整段粘贴进 zsh（# 被当命令、引号续行错乱，2026-09-09 实锤）
- 端口残留处理：dev.sh 因 5173 被上次残留 vite 挡住而退出，kill 残留进程后正常；现象=后端也没起、curl 全空

### 变更原则（本次无变更，沿用既有）

## 2026-09-07 · M1 数据层会话（完结）

### 一句话快照

M1 完成待用户验收；下一步 = 新会话执行 M3a 模板上传与校验（TODO.md 顶部，M2/M3 可并行但建议先 M3a 打通里程碑 1 风险链）。

### 本次完成

- SQLite 七表 schema（WAL + 外键强制）：backend/app/models/{schema,entities,db}.py
- repository 六模块：repositories/{blocks,tags,templates,regions,versions,bindings}.py（纯存储层，无 REST 路由——块路由随 M2、模板随 M3）
- 软删除 D11 原子落地：soft_delete_block 置 deleted_at + 同事务绑定置 missing（异常整体回滚有测试）
- create_app 启动即幂等建库（data/app.db）；config 增 db_path
- 验证：ruff ✓ / mypy 21 文件 ✓ / pytest 32 绿 / 启动建库 WAL 冒烟 ✓

### 接口契约（数据层，M2+ service 层直接消费）

- 事务边界：repository 函数不自行 commit；一个 `get_conn()` with 块 = 一个事务（异常统一回滚）
- 调用范式：`with get_conn() as conn: blocks.create_block(conn, name, content, category)`
- 时间戳：`db.utcnow()` → ISO-8601 定长 TEXT（字典序=时间序），UTC 存储
- 状态枚举在 core/constants.py：REGION_TYPES(9) / TEMPLATE_STATUSES(parsing/pending_review/ready) / REGION_REVIEW_STATUSES / BINDING_STATUSES(active/missing)；schema 无 CHECK，应用层校验（ValueError）
- UNIQUE：tags.name / templates.sha256 / versions(template_id,name) / bindings(version_id,region_id)
- 删除策略：模板/版本/区域/标签物理删+CASCADE；块只软删除，bindings.block_id RESTRICT（物理删被引用块报 IntegrityError）
- anchor/bbox 存 JSON 文本：create 时收 dict 自动 dumps；实体读回为 str，解析归 service 层

### 用户偏好（本次新明确）

- 三假设拍板：①绑定 1:1（UNIQUE(version_id,region_id)）②版本归属模板（M10 换装=新模板下建同名版本+复制迁移绑定）③模板落盘名 {id}_{原文件名}
- M1 只做存储层不做路由：REST 路由随 M2（块）/M3（模板）建
- git 提交流程（M1 会话定，后续模块沿用）：模块自验全绿 → 用户人工验证 → 通过后由 AI 代为提交，无需再询问

### 变更原则（本次无变更，沿用首次定稿）

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

- 本机 python3.12 在 ~/.local/bin/python3.12（uv 安装，系统 python3 是 3.9，勿用）
- LibreOffice 26.8.0.3 已装（brew cask，soffice 在 /opt/homebrew/bin/soffice），health 检测绿
- Node 24 / npm 11；brew 6.0.21
- 陷阱：外部同步曾覆盖 AGENTS.md 陷阱表（P11 行在 M0 提交中丢失，已补回）——改 AGENTS.md 后提交前建议 git diff 确认

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

## 2026-09-21 · M8 版本管理（完结）

### 一句话快照

M0–M8 全部完成（里程碑 2 仅剩「素模板端到端验收」未打勾，里程碑 3 剩 M10+验收）；下一步 = M9 导出 或 M10 换模板迁移（TODO.md 顶部里程碑 3/4，依赖 M6+M7→M9 已满足、M5+M8→M10 已满足）。

### 接口契约（M8 新增）

- `GET /api/templates/{tid}/versions` → `{versions: [{id, template_id, name, binding_count, created_at, updated_at}]}`（创建正序；binding_count = active 绑定数）
- `POST /api/templates/{tid}/versions` `{name, copy_from?}` → 201 Version（copy_from 复制该版本 active 绑定为底稿，missing 不迁移）；重名 → 409 `VERSION_NAME_TAKEN`
- `PATCH /api/versions/{vid}` `{name}` → 200 Version；`DELETE /api/versions/{vid}` → 204（唯一版本 → 400 `LAST_VERSION`；绑定随级联删）
- 错误码新增：`VERSION_INVALID(400)` / `VERSION_NAME_TAKEN(409)` / `LAST_VERSION(400)`；版本名 1–30 字符
- 前端 preview store：`versions` / `selectVersion(id)`（P7 序号整体刷新）/ `createNewVersion(name, copyFrom)`（成功后自动切新版本）/ `renameCurrentVersion(name)` / `deleteCurrentVersion()`（删当前切相邻）
- 工具条版本控件（模板下拉右侧）：版本下拉「名字（N 项绑定）」+ 新建/重命名/删除；校对模式全部置灰（校对对象是模板本体，与版本无关）

### 用户偏好（本次新明确）

- 名称类用户输入字段（块名/版本名等）长度全局统一 **1–30 字符**（已入 AGENTS.md 命名约定，M8 起生效）

### 变更原则

（沿用既有，无新增）
