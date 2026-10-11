import CryptoKit
import Darwin
import Foundation

struct LauncherConfiguration: Codable {
  let mode: String?
  let projectRoot: String?
  let nodeExecutable: String?
}

enum LauncherError: LocalizedError {
  case message(String)
  var errorDescription: String? {
    if case .message(let text) = self { return text }
    return nil
  }
}

enum EndpointState { case ready, closed, foreign }

@MainActor
final class ServiceManager {
  let root: URL
  let node: URL
  let backendPort: Int
  let frontendPort: Int
  private var packagedPython: URL?
  private var dataDirectory: URL?
  private(set) var children: [String: Process] = [:]
  private var logHandles: [FileHandle] = []
  private var stopping = false
  private var expectedStops: Set<Int32> = []
  private let customLogDirectory: URL?
  var onChange: ((String) -> Void)?
  var onFailure: ((String) -> Void)?
  var ownedCount: Int { children.values.filter { $0.isRunning }.count }
  var pageURL: URL {
    URL(string: "http://127.0.0.1:\(packagedPython == nil ? frontendPort : backendPort)/")!
  }
  var logDirectory: URL {
    if let customLogDirectory { return customLogDirectory }
    return FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("ModularDocGenerator/Logs", isDirectory: true)
  }

  init(
    root: URL, node: URL, backendPort: Int = 8740, frontendPort: Int = 5173,
    logDirectory: URL? = nil
  ) {
    self.root = root
    self.node = node
    self.backendPort = backendPort
    self.frontendPort = frontendPort
    self.customLogDirectory = logDirectory
  }

  convenience init(resources: URL, python: URL, dataDirectory: URL, backendPort: Int = 8740) {
    self.init(root: resources, node: python, backendPort: backendPort, frontendPort: backendPort)
    packagedPython = python
    self.dataDirectory = dataDirectory
    try? FileManager.default.createDirectory(at: dataDirectory, withIntermediateDirectories: true)
  }

  func probe(_ backend: Bool) async -> EndpointState {
    if backend || packagedPython != nil {
      return await probeURL(
        URL(string: "http://127.0.0.1:\(backendPort)/api/health")!, backend: true)
    }
    let ipv6 = await probeURL(URL(string: "http://[::1]:\(frontendPort)/")!, backend: false)
    if ipv6 == .ready { return .ready }
    let ipv4 = await probeURL(URL(string: "http://127.0.0.1:\(frontendPort)/")!, backend: false)
    if ipv4 == .ready { return .ready }
    return ipv6 == .closed && ipv4 == .closed ? .closed : .foreign
  }

  private func probeURL(_ url: URL, backend: Bool) async -> EndpointState {
    var request = URLRequest(
      url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 2)
    request.httpMethod = "GET"
    do {
      let (data, response) = try await URLSession.shared.data(for: request)
      guard (response as? HTTPURLResponse)?.statusCode == 200 else { return .foreign }
      if backend {
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        let canonicalPath: String
        if let resolved = realpath(root.path, nil) {
          canonicalPath = String(cString: resolved)
          free(resolved)
        } else {
          canonicalPath = root.path
        }
        let fingerprint = SHA256.hash(data: Data(canonicalPath.utf8)).map {
          String(format: "%02x", $0)
        }.joined()
        if let dataDirectory {
          let resolved: String
          if let path = realpath(dataDirectory.path, nil) {
            resolved = String(cString: path)
            free(path)
          } else {
            resolved = dataDirectory.path
          }
          let dataHash = SHA256.hash(data: Data(resolved.utf8)).map { String(format: "%02x", $0) }
            .joined()
          guard json?["data_fingerprint"] as? String == dataHash else { return .foreign }
        }
        return json?["status"] as? String == "ok"
          && json?["application"] as? String == "modular-doc-generator"
          && json?["project_fingerprint"] as? String == fingerprint ? .ready : .foreign
      }
      return String(data: data, encoding: .utf8)?.contains("模块化文档生成助手") == true ? .ready : .foreign
    } catch let error as URLError where error.code == .cannotConnectToHost {
      return .closed
    } catch {
      return .foreign  // Timeout or unknown listener: never take over its port.
    }
  }

  func launch(_ name: String, executable: URL, arguments: [String], directory: URL) throws {
    guard children[name]?.isRunning != true else { return }
    let fm = FileManager.default
    try fm.createDirectory(at: logDirectory, withIntermediateDirectories: true)
    let logURL = logDirectory.appendingPathComponent("\(name).log")
    if !fm.fileExists(atPath: logURL.path) { _ = fm.createFile(atPath: logURL.path, contents: nil) }
    let handle = try FileHandle(forWritingTo: logURL)
    try handle.truncate(atOffset: 0)  // One current log per service, no request-body logging.
    let process = Process()
    process.executableURL = executable
    process.arguments = arguments
    process.currentDirectoryURL = directory
    var environment = ProcessInfo.processInfo.environment
    environment["PATH"] =
      "\(node.deletingLastPathComponent().path):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    environment["PYTHONUNBUFFERED"] = "1"
    environment["PYTHONDONTWRITEBYTECODE"] = "1"
    if let dataDirectory {
      environment["MODUDOC_DATA_DIR"] = dataDirectory.path
      environment["MODUDOC_STATIC_DIR"] = root.appendingPathComponent("frontend").path
      environment["PYTHONPATH"] = root.appendingPathComponent("backend").path
    }
    process.environment = environment
    process.standardOutput = handle
    process.standardError = handle
    process.terminationHandler = { [weak self] child in
      let code = child.terminationStatus
      let pid = child.processIdentifier
      Task { @MainActor in
        guard let self else { return }
        let expected = self.expectedStops.remove(pid) != nil
        if !expected && !self.stopping { self.onFailure?("\(name)已退出（状态 \(code)），可查看服务日志。") }
        self.onChange?("服务进程状态已更新")
      }
    }
    try process.run()
    children[name] = process
    logHandles.append(handle)
  }

  func start() async throws {
    let backend = await probe(true)
    let frontend = await probe(false)
    guard backend != .foreign && frontend != .foreign else {
      throw LauncherError.message("8740 或 5173 端口被其他服务占用或无法验证，请先检查；本应用不会停止其他进程。")
    }
    let fm = FileManager.default
    let python = packagedPython ?? root.appendingPathComponent("backend/.venv/bin/python")
    let vite = root.appendingPathComponent("frontend/node_modules/vite/bin/vite.js")
    guard fm.fileExists(atPath: root.appendingPathComponent("backend/app/main.py").path),
      fm.fileExists(
        atPath: root.appendingPathComponent(
          packagedPython == nil ? "frontend/package.json" : "frontend/index.html"
        ).path)
    else {
      throw LauncherError.message("项目目录无效，请选择 modular-doc-generator 项目根目录。")
    }
    guard backend == .ready || fm.isExecutableFile(atPath: python.path),
      frontend == .ready || packagedPython != nil
        || (fm.isExecutableFile(atPath: node.path) && fm.fileExists(atPath: vite.path))
    else {
      throw LauncherError.message("依赖未安装：请先运行 scripts/dev.sh 初始化 Python 和前端依赖，再启动应用。")
    }
    let existing = Set(children.filter { $0.value.isRunning }.keys)
    stopping = false
    onChange?("正在启动服务…")
    do {
      if backend == .closed {
        try launch(
          "backend", executable: python,
          arguments: [
            "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(backendPort),
          ],
          directory: root.appendingPathComponent("backend"))
      }
      if frontend == .closed && packagedPython == nil {
        try launch(
          "frontend", executable: node,
          arguments: [
            vite.path, "--host", "localhost", "--port", String(frontendPort), "--strictPort",
          ],
          directory: root.appendingPathComponent("frontend"))
      }
      for _ in 0..<90 {
        let backendReady = await probe(true)
        let frontendReady = await probe(false)
        if backendReady == .ready && frontendReady == .ready {
          onChange?(ownedCount == 0 ? "服务正常（复用已有服务）" : "服务正常（本应用管理 \(ownedCount) 个进程）")
          return
        }
        if children.contains(where: { !existing.contains($0.key) && !$0.value.isRunning }) {
          throw LauncherError.message("服务启动失败，请查看日志；依赖和文稿目录权限需有效。")
        }
        try await Task.sleep(nanoseconds: 300_000_000)
      }
      throw LauncherError.message("服务启动超时，请查看日志并检查运行环境。")
    } catch {
      await stop(names: Set(children.keys).subtracting(existing))
      throw error
    }
  }

  func stop(names: Set<String>? = nil) async {
    stopping = true
    let selected = children.filter { names == nil || names!.contains($0.key) }
    for process in selected.values where process.isRunning {
      expectedStops.insert(process.processIdentifier)
      process.terminate()
    }
    for _ in 0..<75 {
      if !selected.values.contains(where: { $0.isRunning }) { break }
      try? await Task.sleep(nanoseconds: 200_000_000)
    }
    for (name, process) in selected where !process.isRunning { children.removeValue(forKey: name) }
    if ownedCount == 0 {
      for handle in logHandles { try? handle.close() }
      logHandles = []
    }
    stopping = false
    onChange?(ownedCount == 0 ? "本应用启动的服务已停止；已有外部服务保留" : "服务仍在关闭，请稍候再停止")
  }
}
