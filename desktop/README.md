# macOS 桌面应用

本应用使用 Swift AppKit 普通应用窗口、Dock、WKWebView 与可选状态栏入口，CFBundleExecutable 是 Mach-O；服务直接通过 Foundation Process 启动。后端代码、前端生产资源和锁定 Python wheels 随 App 提供，用户数据与运行环境独立到 Application Support，使用者无需源码目录或 Node。

已发布 [v1.3.0-test.3 开源测试版](https://github.com/syh035/modular-doc-generator/releases/tag/v1.3.0-test.3)，包含 arm64／x86_64 ZIP、SHA-256 校验文件及对应源码。

## 构建与运行

使用者需要 macOS 14+、匹配架构的 Python 3.12 和 LibreOffice。环境就绪时启动直接进入工作台；缺少组件时自动打开「环境与服务」。平时从应用菜单「服务管理…」（⌘,）或菜单栏「文档」打开。页面逐项显示 Python、应用依赖、LibreOffice 的安装与验证结果，只为缺失项显示安装／初始化操作；重新检测保留结果页。提供 [Python 官方安装包](https://www.python.org/downloads/release/python-31210/) 与 [LibreOffice 官方下载](https://www.libreoffice.org/download/download-libreoffice/) 入口；安装后重新检测，再点击「初始化应用依赖」。Python 包从 App 内离线安装到应用专用 venv，不改系统 Python；启动还会验证真实 DOCX→PDF 转换。

构建者另需 Xcode Command Line Tools、Node 22 和项目后端 venv。仓库根运行：

```sh
npm ci --prefix frontend
npm run build --prefix frontend
python3 scripts/build_desktop.py --arch arm64 --output /tmp/modudoc-arm64
python3 scripts/build_desktop.py --arch x86_64 --output /tmp/modudoc-intel
python3 scripts/test_desktop.py
python3 scripts/test_packaged.py --app /tmp/modudoc-arm64/模块化文档生成助手.app --python /path/to/python3.12 --conversion
python3 scripts/package_desktop.py --app /tmp/modudoc-arm64/模块化文档生成助手.app --arch arm64 --output /tmp/modudoc-release
```

每个架构须在对应机器或 CI runner 上执行独立 venv 与真实转换验收；交叉编译通过不代表另一架构已运行通过。GitHub `v*-test.*` 标签触发两架构构建、完整门禁、真实预览／导出、源码和 SHA-256 附件收集；全部成功后才公开预发布。

双击 `~/Applications/模块化文档生成助手.app`，自动启动本地服务并在独立窗口展示现有 Vue 工作台，不再调用浏览器。关闭窗口后应用保留在 Dock，重复双击图标恢复同一窗口；⌘Q 退出并停止本应用拥有的服务。应用菜单「服务管理…」（⌘,）及菜单栏「文档」提供服务与日志入口。本机桌面入口为指向正式应用的符号链接，更新应用不需重建入口。

文件上传使用系统打开面板；DOCX 导出使用系统保存面板。WebKit 先保存到同目录唯一临时文件，完成后移动或替换用户在保存面板确认的文件；失败保留原导出，取消清理临时文件。工作台内使用同源回环页面，外部 HTTP(S) 链接交给浏览器。PDF.js 继续绘制原 DOCX→LibreOffice→PDF 产物。

构建可选择 arm64／x86_64（macOS 14+），默认 ad-hoc 本地签名并严格验签；没有 Developer ID 公证，互联网下载后不能保证直接通过 Gatekeeper。后续正式分发需 Developer ID 与 Apple 公证。不要移除 quarantine 或关闭系统保护。组合 App 的 AGPL-3.0、原创源码 MIT、第三方许可和对应源码详见 [分发说明](DISTRIBUTION.md)。

用户数据位于 `~/Library/Application Support/ModularDocGenerator/Data`，专用 Python venv 位于 `Runtime/py312-架构-依赖摘要`，日志位于 `Logs`。App 更新／移动不影响用户数据。服务管理「导入旧版数据」仅接受空目标，复制 SQLite 一致性备份、校验模板指纹并保留源目录；先停止旧版服务。初始化过的空目标也会保留为 `Data-before-import-*`。既有非空数据不会被覆盖。

## 使用流程

1. **导入模板**：顶栏「更多」→「导入模板」选 .docx → 自动解析出候选区域并选中新模板；「模板制作指南」也在「更多」中
2. **校对**：状态栏开启校对模式 → 确认 / 排除候选、调整边界；展开画布底部「预览工具」→「添加遗漏区域」可进入拖拽补选，每次框选一个段落。未定位项可点击后直接重新框选，保留已有区域与绑定；全部处理完模板自动转「可用」
3. **建块绑定**：左缘展开字符块库 → 新建块 → 点选块、点预览上的区域完成绑定（或区域浮层反向绑定）
4. **版本与导出**：文档工具条「管理」打开模板与版本面板，新建 / 复制 / 重命名 / 删除版本，点「使用」打开 →「导出」下载 DOCX；工具条两个下拉可快速切换模板与内容版本
5. **归档**：在当前工作稿旁点击「归档」→ 填写名称 → 保存当时的 Word 与 PDF。工作稿仍可继续编辑，后续共享修改和原模板删除不影响归档；若存在大超出，须明确确认后归档。
6. **归档库**：从顶栏「归档库」搜索、查看、下载 Word／PDF 或删除归档。归档只读，删除归档不删除工作稿；普通导出不自动生成归档。

编辑共享块时会列出引用模板和版本，可选择仅修改当前版本；删除前同样显示影响范围。从服务状态进入「预览维护」可手动清理缓存；当前文档可刷新时重新生成预览，其他情况在下次生成时重建。字体安装或转换器更新也会自动使旧转换缓存失效。应用内备份与恢复功能已移除；磁盘上的已有备份文件保持原位，旧版数据导入保护保留。

弹层打开时背景操作暂停，按 Esc 或点遮罩关闭，Tab/Shift+Tab 在弹层内切换焦点，关闭后回到打开前的位置。块库分隔条可用 Tab 聚焦，再按左右方向键每次调整 16px；宽度随鼠标或键盘调整自动记忆。

顶栏日常只显示「工作台／归档库／更多」；「更多」收纳导入模板、模板制作指南、撤销和重做，撤销快捷键仍可使用。文档工具条保留块库、模板／内容版本快速选择、「管理」「归档」和「导出」；浏览管理面板中的模板不会切换工作台，点击「使用」才打开版本。

画布底部「预览工具」按需展开缩放、添加遗漏区域和图例，底部仍显示绑定统计或校对进度，展开不遮挡 PDF。溢出区域提示集中在底部状态栏，点击可滚页定位并闪烁 1.8 秒；提示增减不改变画布高度。窄屏保留块库抽屉入口。

块库和模板管理的「批量管理」均支持全选当前搜索／筛选结果；切换筛选清除勾选，删除前二次确认，部分失败保留失败项并显示原因。模板删除永久移除原件、全部版本、区域及绑定；有有效绑定时先解绑或删除对应块。字符块仍采用软删除，保留原有恢复规则。

## 服务与通知

- 分发 App 只有一个后端进程，固定 127.0.0.1:8740 同源提供 API 与生产前端；源码开发模式仍使用 8740／5173。健康身份须同时匹配应用资源与数据目录才能复用。
- 已有服务不会被应用停止。端口被其他程序占用时明确报错，应用不会按端口杀进程。部分启动失败回滚本次新启动的服务。
- 「停止本应用服务」与退出发送正常终止请求；仍未结束时保留进程引用并提示重试，不强杀。
- 日志位于 `~/Library/Application Support/ModularDocGenerator/Logs/`，每次启动保留当前服务日志，不记录请求正文或文稿内容。
- 「允许系统通知」是用户主动开启的可选入口。未授权仍可通过窗口查看状态；通知只在服务变化／失败等事件出现，不自动修改系统通知设置。

## 验证

Swift 编译警告按错误处理，swift-format lint；Python 构建脚本通过 ruff 和 mypy。生命周期用合成服务验证启动、复用、所有权、不同项目保护、正常停止、外部端口保护与部分启动回滚；导出文件测试覆盖新建、替换、失败保留与并发保护。真实窗口验收另外验证启动／停止／重启及 LibreOffice 预览导出。

实现依据：[AppKit NSStatusBar](https://developer.apple.com/documentation/appkit/nsstatusbar)、[Foundation Process](https://developer.apple.com/documentation/foundation/process)、[UserNotifications](https://developer.apple.com/documentation/usernotifications)。

不传 --output 时产物位于 desktop/build。文稿目录受 FileProvider 管理时，启动可能重新写入包根 FinderInfo，触发严格验签的附加元数据错误；建议安装到 Applications，并在实际启动后复核严格签名。不要移除 quarantine 或关闭系统保护来处理此现象。
