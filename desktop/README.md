# macOS 桌面应用

本应用使用 Swift AppKit 普通应用窗口、Dock、WKWebView 与可选状态栏入口，CFBundleExecutable 是 Mach-O；服务直接通过 Foundation Process 启动。后端代码、前端生产资源和锁定 Python wheels 随 App 提供，用户数据与运行环境独立到 Application Support，使用者无需源码目录或 Node。

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

## 服务与通知

- 分发 App 只有一个后端进程，固定 127.0.0.1:8740 同源提供 API 与生产前端；源码开发模式仍使用 8740／5173。健康身份须同时匹配应用资源与数据目录才能复用。
- 已有服务不会被应用停止。端口被其他程序占用时明确报错，应用不会按端口杀进程。部分启动失败回滚本次新启动的服务。
- 「停止本应用服务」与退出发送正常终止请求；仍未结束时保留进程引用并提示重试，不强杀。
- 日志位于 `~/Library/Application Support/ModularDocGenerator/Logs/`，每次启动保留当前服务日志，不记录请求正文或文稿内容。
- 「允许系统通知」是用户主动开启的可选入口。未授权仍可通过窗口查看状态；通知只在服务变化／失败等事件出现，不自动修改系统通知设置。

## 验证

Swift 编译警告按错误处理，swift-format lint；Python 构建脚本通过 ruff 和 mypy。生命周期用合成服务验证启动、复用、所有权、不同项目保护、正常停止、外部端口保护与部分启动回滚；导出文件测试覆盖新建、替换、失败保留与并发保护。真实窗口验收另外验证启动／停止／重启及 LibreOffice 预览导出。

实现依据：[AppKit NSStatusBar](https://developer.apple.com/documentation/appkit/nsstatusbar)、[Foundation Process](https://developer.apple.com/documentation/foundation/process)、[UserNotifications](https://developer.apple.com/documentation/usernotifications)。

不传 --output 时产物位于 desktop/build。文稿目录受 FileProvider 管理时，启动可能重新写入包根 FinderInfo，触发严格验签的附加元数据错误；本机正式交付改用个人 Applications 目录，并在实际启动后再次严格验签通过。不要移除 quarantine 或关闭系统保护来处理此现象。

正式发布待办：Developer ID 签名与 Apple 公证、干净 macOS 14 机器验收；Windows 外壳暂不支持。本次依照用户最新决定采用环境检测与安装引导，替代完整运行时打包。
