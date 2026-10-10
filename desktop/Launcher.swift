import AppKit
import UserNotifications

@MainActor
final class LauncherDelegate: NSObject, NSApplicationDelegate {
  private var workbench: WorkbenchWindow!
  private var item: NSStatusItem!
  private var window: NSWindow!
  private var statusLabel: NSTextField!
  private var pathLabel: NSTextField!
  private var startButton: NSButton!
  private var stopButton: NSButton!
  private var stopMenu: NSMenuItem!
  private var manager: ServiceManager!
  private var configuration: LauncherConfiguration!
  private var runtime: RuntimeEnvironment?
  private var environmentProblem: String?
  private var pythonLabel: NSTextField!
  private var dependenciesLabel: NSTextField!
  private var officeLabel: NSTextField!
  private var pythonInstallButton: NSButton!
  private var officeInstallButton: NSButton!
  private var dependenciesButton: NSButton!
  private var conversionVerified = false
  private var busy = false
  private var timer: Timer?

  func applicationDidFinishLaunching(_ notification: Notification) {
    do {
      guard let configURL = Bundle.main.url(forResource: "launcher", withExtension: "json") else {
        throw LauncherError.message("应用配置缺失，请重新运行桌面构建脚本。")
      }
      configuration = try JSONDecoder().decode(
        LauncherConfiguration.self, from: Data(contentsOf: configURL))
      if configuration.mode == "packaged" {
        guard let resources = Bundle.main.resourceURL else { throw LauncherError.message("应用资源缺失") }
        runtime = try RuntimeEnvironment(resources: resources)
        manager = ServiceManager(
          resources: resources, python: runtime!.python, dataDirectory: runtime!.data)
      } else {
        guard let root = configuration.projectRoot, let node = configuration.nodeExecutable else {
          throw LauncherError.message("应用配置无效")
        }
        manager = ServiceManager(root: URL(fileURLWithPath: root), node: URL(fileURLWithPath: node))
      }
      createUI()
      attachCallbacks()
      Task { await startServices() }
      timer = Timer.scheduledTimer(withTimeInterval: 4, repeats: true) { [weak self] _ in
        Task { @MainActor in await self?.refreshStatus() }
      }
    } catch {
      showError(error.localizedDescription)
      NSApp.terminate(nil)
    }
  }

  private func attachCallbacks() {
    manager.onChange = { [weak self] text in self?.setStatus(text) }
    manager.onFailure = { [weak self] text in
      self?.setStatus(text)
      self?.notify(text)
    }
  }
  private func button(_ title: String, _ action: Selector) -> NSButton {
    let button = NSButton(title: title, target: self, action: action)
    button.bezelStyle = .rounded
    button.setContentCompressionResistancePriority(.required, for: .horizontal)
    button.setContentHuggingPriority(.required, for: .horizontal)
    return button
  }
  private func label(_ text: String, size: CGFloat = 13, secondary: Bool = false) -> NSTextField {
    let field = NSTextField(wrappingLabelWithString: text)
    field.font = .systemFont(ofSize: size)
    field.textColor = secondary ? .secondaryLabelColor : .labelColor
    return field
  }
  private func stack(_ views: [NSView], horizontal: Bool = false) -> NSStackView {
    let arranged = horizontal && views.allSatisfy { $0 is NSButton } ? views + [NSView()] : views
    let view = NSStackView(views: arranged)
    view.distribution = .fill
    view.orientation = horizontal ? .horizontal : .vertical
    view.alignment = horizontal ? .centerY : .leading
    view.spacing = horizontal ? 10 : 8
    view.translatesAutoresizingMaskIntoConstraints = false
    return view
  }
  private func card(_ rows: [NSView]) -> NSBox {
    let box = NSBox()
    box.boxType = .custom
    box.borderColor = .separatorColor
    box.borderWidth = 0.5
    box.cornerRadius = 10
    box.fillColor = .controlBackgroundColor
    box.contentViewMargins = .zero
    box.translatesAutoresizingMaskIntoConstraints = false
    let content = stack(rows)
    content.spacing = 14
    box.contentView!.addSubview(content)
    NSLayoutConstraint.activate([
      content.leadingAnchor.constraint(equalTo: box.contentView!.leadingAnchor, constant: 16),
      content.trailingAnchor.constraint(equalTo: box.contentView!.trailingAnchor, constant: -16),
      content.topAnchor.constraint(equalTo: box.contentView!.topAnchor, constant: 16),
      content.bottomAnchor.constraint(equalTo: box.contentView!.bottomAnchor, constant: -16),
    ])
    for row in rows { row.widthAnchor.constraint(equalTo: content.widthAnchor).isActive = true }
    return box
  }
  private func environmentRow(_ title: String, status: NSTextField, actions: [NSView]) -> NSView {
    let heading = label(title)
    heading.font = .systemFont(ofSize: 13, weight: .semibold)
    let detail = stack([heading, status])
    detail.spacing = 4
    let row = stack([detail] + actions, horizontal: true)
    detail.setContentHuggingPriority(.defaultLow, for: .horizontal)
    return row
  }
  private func createUI() {
    item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    item.button?.image = NSImage(
      systemSymbolName: "doc.text", accessibilityDescription: "模块化文档生成助手")
    item.button?.title = " 文档"
    let menu = NSMenu()
    for (title, action) in [
      ("打开工作台", #selector(openPage)), ("打开服务管理", #selector(showManager)),
      ("启动服务", #selector(startClicked)), ("停止本应用启动的服务", #selector(stopClicked)),
      ("打开数据目录", #selector(openData)), ("查看服务日志", #selector(openLogs)),
      ("允许系统通知…", #selector(enableNotifications)), ("退出并停止本应用服务", #selector(quit)),
    ] {
      let entry = NSMenuItem(title: title, action: action, keyEquivalent: "")
      entry.target = self
      menu.addItem(entry)
      if action == #selector(stopClicked) { stopMenu = entry }
    }
    menu.autoenablesItems = false
    item.menu = menu
    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 680, height: 640),
      styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
    window.title = "环境与服务"
    window.isReleasedWhenClosed = false
    window.center()
    let title = label("环境与服务", size: 24)
    title.font = .systemFont(ofSize: 24, weight: .semibold)
    let intro = label("环境就绪时直接进入工作台。缺少组件时会打开此页，安装后重新检测即可。", secondary: true)
    let environmentHeading = label("运行环境")
    environmentHeading.font = .systemFont(ofSize: 13, weight: .semibold)
    pythonLabel = label("正在检测…", size: 12, secondary: true)
    dependenciesLabel = label("正在检测…", size: 12, secondary: true)
    officeLabel = label("正在检测…", size: 12, secondary: true)
    pythonInstallButton = button("下载安装", #selector(openPython))
    officeInstallButton = button("下载安装", #selector(openLibreOffice))
    dependenciesButton = button("初始化依赖", #selector(installRuntime))
    let environment = card([
      environmentRow("Python 3.12", status: pythonLabel, actions: [pythonInstallButton]),
      environmentRow("应用依赖", status: dependenciesLabel, actions: [dependenciesButton]),
      environmentRow("LibreOffice", status: officeLabel, actions: [officeInstallButton]),
      stack(
        [
          label("检测安装情况，并验证实际文档转换。", size: 12, secondary: true),
          button("重新检测", #selector(recheckEnvironment)),
        ], horizontal: true),
    ])
    statusLabel = label("正在检查服务…")
    statusLabel.font = .systemFont(ofSize: 13, weight: .medium)
    startButton = button("启动服务", #selector(startClicked))
    stopButton = button("停止服务", #selector(stopClicked))
    let service = card([
      label("本地服务", size: 13), statusLabel,
      stack([startButton, stopButton, button("查看日志", #selector(openLogs))], horizontal: true),
    ])
    pathLabel = label(runtime?.data.path ?? manager.root.path, size: 12, secondary: true)
    pathLabel.isSelectable = true
    let data = card([
      label("数据与高级设置"), pathLabel,
      stack(
        [
          button("打开数据目录", #selector(openData)), button("导入旧版数据…", #selector(importData)),
          button("选择 Python…", #selector(choosePython)),
        ], horizontal: true),
    ])
    let open = button("进入工作台", #selector(openPage))
    open.bezelColor = .controlAccentColor
    let footer = stack(
      [
        label("应用菜单「服务管理…」或 ⌘, 可随时打开此页。", size: 12, secondary: true), open,
      ], horizontal: true)
    let content = stack([title, intro, environmentHeading, environment, service, data, footer])
    content.spacing = 12
    window.contentView!.addSubview(content)
    NSLayoutConstraint.activate([
      content.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor, constant: 24),
      content.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor, constant: -24),
      content.topAnchor.constraint(equalTo: window.contentView!.topAnchor, constant: 24),
      content.bottomAnchor.constraint(
        lessThanOrEqualTo: window.contentView!.bottomAnchor, constant: -24),
    ])
    for view in [intro, environment, service, data, footer] {
      view.widthAnchor.constraint(equalTo: content.widthAnchor).isActive = true
    }
    pythonInstallButton.isHidden = true
    officeInstallButton.isHidden = true
    dependenciesButton.isHidden = true
    createApplicationMenu()
    workbench = WorkbenchWindow()
    workbench.show()
  }
  private func createApplicationMenu() {
    let menu = NSMenu()
    let appEntry = NSMenuItem()
    menu.addItem(appEntry)
    let appMenu = NSMenu()
    appMenu.addItem(withTitle: "服务管理…", action: #selector(showManager), keyEquivalent: ",").target =
      self
    appMenu.addItem(.separator())
    appMenu.addItem(withTitle: "退出模块化文档生成助手", action: #selector(quit), keyEquivalent: "q").target =
      self
    appEntry.submenu = appMenu
    let editEntry = NSMenuItem(title: "编辑", action: nil, keyEquivalent: "")
    menu.addItem(editEntry)
    let editMenu = NSMenu(title: "编辑")
    for (title, action, key) in [
      ("剪切", #selector(NSText.cut(_:)), "x"),
      ("复制", #selector(NSText.copy(_:)), "c"),
      ("粘贴", #selector(NSText.paste(_:)), "v"),
      ("全选", #selector(NSText.selectAll(_:)), "a"),
    ] {
      editMenu.addItem(withTitle: title, action: action, keyEquivalent: key)
    }
    editEntry.submenu = editMenu
    NSApp.mainMenu = menu
  }
  private func setStatus(_ text: String) {
    statusLabel?.stringValue = text
    item?.button?.toolTip = text
    dependenciesButton?.isEnabled = !busy && runtime?.basePython != nil && manager.ownedCount == 0
    startButton?.isEnabled = !busy
    stopButton?.isEnabled = !busy && manager.ownedCount > 0
    stopMenu?.isEnabled = !busy && manager.ownedCount > 0
  }
  private func refreshStatus() async {
    guard !busy, environmentProblem == nil else { return }
    let backend = await manager.probe(true)
    let frontend = await manager.probe(false)
    if backend == .ready && frontend == .ready {
      setStatus(manager.ownedCount == 0 ? "已连接本地服务 · 可以预览和导出" : "服务已就绪 · 可以预览和导出")
    } else {
      setStatus("服务未就绪，可点击启动服务或查看日志")
    }
  }
  private func startServices(showWorkbench: Bool = true) async {
    guard !busy else { return }
    busy = true
    environmentProblem = nil
    setStatus("正在检查与启动服务…")
    conversionVerified = false
    if let runtime {
      let problem = await runtime.detect()
      updateEnvironment()
      if let problem {
        busy = false
        environmentProblem = problem
        setStatus(problem)
        workbench.showMessage(problem + "\n请在服务管理中按提示完成安装。")
        showManager()
        return
      }
    }
    do {
      try await manager.start()
      if runtime != nil {
        setStatus("正在验证 LibreOffice 实际文档转换…")
        var request = URLRequest(
          url: manager.pageURL.appendingPathComponent("api/environment/check"), timeoutInterval: 90)
        request.httpMethod = "POST"
        let (data, response) = try await URLSession.shared.data(for: request)
        let result = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        guard (response as? HTTPURLResponse)?.statusCode == 200,
          result?["conversion_ready"] as? Bool == true
        else {
          throw LauncherError.message("LibreOffice 文档转换验证失败，请检查安装或查看服务日志后重新检测。")
        }
      }
      conversionVerified = runtime != nil
      updateEnvironment()
      busy = false
      await refreshStatus()
      workbench.load(manager.pageURL)
      if showWorkbench { workbench.show() }
      notify("服务已就绪。")
    } catch {
      busy = false
      environmentProblem = error.localizedDescription
      updateEnvironment()
      setStatus(error.localizedDescription)
      workbench.showMessage(error.localizedDescription)
      showError(error.localizedDescription)
    }
  }
  private func updateEnvironment() {
    guard let runtime else { return }
    let pythonFound = runtime.basePython != nil
    pythonLabel.stringValue = pythonFound ? "✓ 已安装 · 版本与应用架构匹配" : "未检测到匹配版本 · 需要安装"
    pythonLabel.textColor = pythonFound ? .systemGreen : .systemOrange
    pythonLabel.toolTip = runtime.basePython?.path
    dependenciesLabel.stringValue =
      runtime.dependenciesReady
      ? "✓ 已就绪 · 无需再次初始化"
      : (pythonFound ? "尚未就绪 · 从应用内离线安装" : "等待 Python 安装完成")
    dependenciesLabel.textColor = runtime.dependenciesReady ? .systemGreen : .systemOrange
    officeLabel.stringValue =
      runtime.libreOffice != nil
      ? (conversionVerified ? "✓ 已安装 · 文档转换验证通过" : "✓ 已安装 · 转换尚未验证")
      : "未检测到可运行版本 · 需要安装"
    officeLabel.textColor = runtime.libreOffice != nil ? .systemGreen : .systemOrange
    officeLabel.toolTip = runtime.libreOffice?.path
    pythonInstallButton.isHidden = pythonFound
    officeInstallButton.isHidden = runtime.libreOffice != nil
    dependenciesButton.isHidden = runtime.dependenciesReady
    dependenciesButton.isEnabled = pythonFound && !busy && manager.ownedCount == 0
  }
  @objc private func recheckEnvironment() {
    Task { await startServices(showWorkbench: false) }
  }
  @objc private func startClicked() { Task { await startServices() } }
  @objc private func stopClicked() {
    guard !busy else { return }
    busy = true
    setStatus("正在停止本应用服务…")
    Task {
      await manager.stop()
      busy = false
      setStatus(manager.ownedCount == 0 ? "本应用服务已停止（外部服务保留）" : "服务仍在关闭，请稍候")
      notify("本应用服务停止操作已完成。")
    }
  }
  @objc private func openPage() {
    Task {
      let backend = await manager.probe(true)
      let frontend = await manager.probe(false)
      if backend == .ready && frontend == .ready {
        workbench.load(manager.pageURL)
        workbench.show()
      } else {
        await startServices()
        if await manager.probe(true) == .ready, await manager.probe(false) == .ready {
          workbench.load(manager.pageURL)
          workbench.show()
        }
      }
    }
  }
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool
  {
    workbench?.show()
    return true
  }
  @objc private func showManager() {
    window?.makeKeyAndOrderFront(nil)
    NSApp.activate()
  }
  @objc private func openData() {
    let url = runtime?.data ?? manager.root
    try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    NSWorkspace.shared.open(url)
  }
  @objc private func openPython() {
    NSWorkspace.shared.open(URL(string: "https://www.python.org/downloads/release/python-31210/")!)
  }
  @objc private func openLibreOffice() {
    NSWorkspace.shared.open(
      URL(string: "https://www.libreoffice.org/download/download-libreoffice/")!)
  }
  @objc private func choosePython() {
    guard !busy else { return }
    let panel = NSOpenPanel()
    panel.message = "选择已安装的 Python 3.12 可执行文件"
    panel.canChooseDirectories = false
    panel.begin { response in
      guard response == .OK, let url = panel.url else { return }
      UserDefaults.standard.set(url.path, forKey: "pythonExecutable")
      Task { await self.startServices() }
    }
  }
  @objc private func installRuntime() {
    guard !busy, let runtime, manager.ownedCount == 0 else {
      showError("请先停止本应用服务，再初始化依赖。")
      return
    }
    busy = true
    setStatus("正在离线初始化 Python 依赖，请稍候…")
    Task {
      do {
        try await runtime.install()
        busy = false
        await startServices()
      } catch {
        busy = false
        setStatus(error.localizedDescription)
        showError(error.localizedDescription)
      }
    }
  }
  @objc private func importData() {
    guard !busy, let runtime, manager.ownedCount == 0 else {
      showError("请先停止本应用服务，再导入旧版数据；源服务也需停止。")
      return
    }
    let panel = NSOpenPanel()
    panel.canChooseFiles = false
    panel.canChooseDirectories = true
    panel.message = "选择旧版 data 目录；仅复制原数据库、模板与导出，不修改源目录。目标必须为空。"
    panel.begin { response in
      guard response == .OK, let url = panel.url else { return }
      self.busy = true
      self.setStatus("正在复制旧版数据…")
      Task {
        do {
          try await runtime.migrate(from: url)
          self.busy = false
          await self.startServices()
        } catch {
          self.busy = false
          self.showError(error.localizedDescription)
        }
      }
    }
  }
  @objc private func openLogs() { NSWorkspace.shared.open(manager.logDirectory) }
  @objc private func enableNotifications() {
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) {
      [weak self] granted, _ in
      Task { @MainActor in self?.setStatus(granted ? "系统通知已启用" : "系统通知未授权，可在系统设置中调整") }
    }
  }
  private func notify(_ text: String) {
    let center = UNUserNotificationCenter.current()
    center.getNotificationSettings { settings in
      guard settings.authorizationStatus == .authorized else { return }
      let content = UNMutableNotificationContent()
      content.title = "模块化文档生成助手"
      content.body = text
      UNUserNotificationCenter.current().add(
        UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
    }
  }
  private func showError(_ text: String) {
    let alert = NSAlert()
    alert.messageText = "服务启动提示"
    alert.informativeText = text
    alert.addButton(withTitle: "知道了")
    alert.runModal()
  }
  @objc private func quit() { NSApp.terminate(nil) }
  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    if busy {
      setStatus("请等待当前服务操作完成后退出")
      return .terminateCancel
    }
    guard manager != nil && manager.ownedCount > 0 else { return .terminateNow }
    busy = true
    Task {
      await manager.stop()
      busy = false
      if manager.ownedCount > 0 {
        showError("服务仍在关闭，请稍候再退出。")
        sender.reply(toApplicationShouldTerminate: false)
      } else {
        sender.reply(toApplicationShouldTerminate: true)
      }
    }
    return .terminateLater
  }
}

@main
struct Launcher {
  @MainActor static func main() {
    let application = NSApplication.shared
    let delegate = LauncherDelegate()
    application.delegate = delegate
    application.setActivationPolicy(.regular)
    withExtendedLifetime(delegate) { application.run() }
  }
}
