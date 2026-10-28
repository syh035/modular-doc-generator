# macOS 桌面应用

本应用使用 Swift AppKit 普通应用窗口、Dock、WKWebView 与可选状态栏入口，CFBundleExecutable 是 Mach-O；服务直接通过 Foundation Process 启动。后端代码、前端生产资源和锁定 Python wheels 随 App 提供，用户数据与运行环境独立到 Application Support，使用者无需源码目录或 Node。

已发布 [v1.3.0-test.5 开源测试版](https://github.com/syh035/modular-doc-generator/releases/tag/v1.3.0-test.5)，包含 arm64／x86_64 ZIP、SHA-256 校验文件及对应源码。

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

以下操作对应当前源码，固定标签下载包以该版本更新日志为准。

1. **导入模板并新建**：点击「导入模板」选 .docx，只保存版式和识别区域，进入模板页；点击「前往文稿页新建」，填写文稿名称再创建。取消不建稿；删除最后一稿后模板仍可使用，旧默认稿保留。「模板制作指南」在「更多」中。
2. **检查区域**：模板页或文档底部进入「检查区域」→ 自动显示模板原文 → 从区域清单或「下一处待检查」定位，保留、忽略、调整或删除 → 完成后返回模板页或当前文档。结果逐项保存、用于该模板所有文稿，零文稿模板也能检查；返回文档恢复缩放、滚动及未保存的字段文字。页眉／页脚／文本框清单只作说明，保留原样。
3. **编辑与素材**：点击正文直接在侧栏编辑，默认只改当前稿。「选用素材」在同栏搜索和选择，返回保留未保存文字；左侧「设定为素材」将当前文字保存为新素材并关联此字段。展开「插入与排版」可在上／下插入独立空行，空行同样可绑定、编辑、继续插入和删除；原字段内容保留。
4. **文稿与导出**：首页按模板分组，组内可新建或继续编辑；每份文稿旁和编辑页的「文稿操作」提供另存、重命名和删除。编辑页显示当前文稿、所用模板与保存状态，点击「导出」下载 DOCX。
5. **归档**：在当前工作稿旁点击「归档」→ 填写名称 → 保存当时的 Word 与 PDF。工作稿仍可继续编辑，后续素材修改和来源删除不影响归档；若存在大超出或素材同步删除造成的留空字段，列出具体位置，可定位补全或明确确认继续。普通导出沿用同样提示。
6. **归档库**：从顶栏「归档库」搜索、查看、下载 Word／PDF 或删除归档。归档只读，删除归档不删除工作稿；普通导出不自动生成归档。

需要补选时，在「检查区域」任务内点击「添加区域」→ 直接在同一原模板画布框选一个段落 → 在画布内使用默认名或修改名称 →「保存并返回文档」（独立检查时返回模板）；也可「保存并继续添加」。区域类型按需展开，空白或跨段错误可重新框选并保留输入。未定位项重新框选保留原区域与绑定，取消添加保留检查任务。

素材编辑／删除会列出仍引用它的文稿和字段，按需勾选同步。未勾选的字段保留现有文字并成为独立内容，已个性化的字段不列入；同步删除让所选字段留空、高亮并在输出前提醒，不删除整段。名称和标签修改不影响文稿文字。素材库支持名称／正文／标签搜索和批量增添、替换、移除标签。从服务状态进入「预览维护」可手动清理缓存；字体或转换器变化自动使旧缓存失效。应用内备份恢复已移除，已有备份文件与旧库迁移保护保留。

确认弹层打开时背景操作暂停，Esc 或遮罩关闭，Tab/Shift+Tab 在弹层内切换，关闭后归还焦点；字段编辑与素材选择为侧栏，文稿仍可见。区域命名或位置保存期间锁定退出和重复提交，失败保留草稿；写入成功但预览失败只重试预览。块库分隔条支持 Tab 聚焦和左右键调宽，每次 16px，自动记忆。

顶栏为「文稿／模板／素材／归档库」；「更多」收纳导入、指南、撤销和重做，快捷键保留。模板页管理原 Word 与区域，显示检查和新建引导；浏览其他页面保留当前稿。素材页管理全库可复用文字，新建不自动加入模板，当前稿独立编辑不混入素材库。文稿操作中的「更换模板」可查看新模板真实 PDF，逐段安排文字或明确不带入后创建新稿，取消不建稿，原稿保留。

画布底部提供「检查区域」，添加位于检查任务内；「预览工具」按需展开缩放和图例，普通编辑显示绑定统计，检查时显示进度。独立空行与待补字段另有直接编辑入口，无文字也能选中。溢出提示集中在底部，点击滚页定位并闪烁 1.8 秒；窄屏保留块库抽屉，正文和字段编辑上下排列。

素材和模板的「批量管理」只全选当前可见结果；切换筛选清除勾选，删除前确认，部分失败保留失败项和原因。素材批量删除逐项核对引用范围。模板删除移除原件及其文稿／区域；有有效绑定或独立插入行时先处理依赖。素材采用软删除，当前会话可通过撤销恢复。

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
