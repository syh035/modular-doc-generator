import AppKit
import Foundation

@MainActor
final class RuntimeEnvironment {
  let resources: URL
  let support: URL
  let data: URL
  let python: URL
  private(set) var basePython: URL?
  private(set) var dependenciesReady = false
  private(set) var libreOffice: URL?
  private let files = FileManager.default
  private let pythonCandidates: [String]?
  private let officeCandidates: [String]?

  init(
    resources: URL, supportDirectory: URL? = nil,
    pythonCandidates: [String]? = nil, officeCandidates: [String]? = nil
  ) throws {
    self.resources = resources
    self.pythonCandidates = pythonCandidates
    self.officeCandidates = officeCandidates
    support =
      supportDirectory
      ?? files.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("ModularDocGenerator", isDirectory: true)
    data = support.appendingPathComponent("Data", isDirectory: true)
    let manifest = try String(
      contentsOf: resources.appendingPathComponent("environment-id"), encoding: .utf8
    ).trimmingCharacters(in: .whitespacesAndNewlines)
    python = support.appendingPathComponent("Runtime/\(manifest)/bin/python")
    try files.createDirectory(at: support, withIntermediateDirectories: true)
  }

  private func run(_ executable: URL, _ arguments: [String]) async throws -> Int32 {
    let logs = support.appendingPathComponent("Logs", isDirectory: true)
    try files.createDirectory(at: logs, withIntermediateDirectories: true)
    let file = logs.appendingPathComponent("environment.log")
    if !files.fileExists(atPath: file.path) { files.createFile(atPath: file.path, contents: nil) }
    let handle = try FileHandle(forWritingTo: file)
    defer { try? handle.close() }
    try handle.seekToEnd()
    let process = Process()
    process.executableURL = executable
    process.arguments = arguments
    process.standardOutput = handle
    process.standardError = handle
    var environment = ProcessInfo.processInfo.environment
    environment["PYTHONDONTWRITEBYTECODE"] = "1"
    process.environment = environment
    try process.run()
    for _ in 0..<3000 {
      if !process.isRunning { return process.terminationStatus }
      try await Task.sleep(nanoseconds: 200_000_000)
    }
    process.terminate()
    throw LauncherError.message("环境操作超时，请查看环境日志后重新检测。")
  }

  func detect() async -> String? {
    let stored = UserDefaults.standard.string(forKey: "pythonExecutable")
    let candidates =
      pythonCandidates
      ?? [
        stored, "/Library/Frameworks/Python.framework/Versions/3.12/bin/python3.12",
        "/opt/homebrew/bin/python3.12", "/usr/local/bin/python3.12",
        files.homeDirectoryForCurrentUser.appendingPathComponent(".local/bin/python3.12").path,
      ]
      .compactMap { $0 }
    #if arch(arm64)
      let machine = "arm64"
    #else
      let machine = "x86_64"
    #endif
    basePython = nil
    for path in candidates where files.isExecutableFile(atPath: path) {
      if (try? await run(
        URL(fileURLWithPath: path),
        [
          "-c",
          "import sys,platform; assert sys.version_info[:2]==(3,12); assert platform.machine()=='\(machine)'",
        ])) == 0
      {
        basePython = URL(fileURLWithPath: path)
        break
      }
    }
    dependenciesReady = false
    if files.isExecutableFile(atPath: python.path) {
      dependenciesReady =
        (try? await run(
          python,
          [
            "-c",
            "import fastapi,uvicorn,multipart,docx,lxml,fitz; from importlib.metadata import version; import pathlib; lines=pathlib.Path(\(String(reflecting: resources.appendingPathComponent("requirements-release.txt").path))).read_text().splitlines(); assert all(version(line.split('==')[0])==line.split('==')[1] for line in lines if '==' in line)",
          ])) == 0
    }
    let lo =
      officeCandidates ?? [
        "/Applications/LibreOffice.app/Contents/MacOS/soffice", "/opt/homebrew/bin/soffice",
        "/usr/local/bin/soffice",
        files.homeDirectoryForCurrentUser.appendingPathComponent(
          "Applications/LibreOffice.app/Contents/MacOS/soffice"
        ).path,
      ]
    libreOffice = nil
    for path in lo where files.isExecutableFile(atPath: path) {
      if (try? await run(URL(fileURLWithPath: path), ["--version"])) == 0 {
        libreOffice = URL(fileURLWithPath: path)
        break
      }
    }
    guard basePython != nil else { return "未找到匹配此应用架构的 Python 3.12。请安装后重新检测。" }
    guard dependenciesReady else { return "Python 已安装，需要初始化应用依赖。依赖来自安装包，不需要联网。" }
    guard libreOffice != nil else { return "未检测到可运行的 LibreOffice。请安装后重新检测。" }
    return nil
  }

  func install() async throws {
    _ = await detect()
    guard let basePython else { throw LauncherError.message("请先安装 Python 3.12，再重新检测。") }
    let environment = python.deletingLastPathComponent().deletingLastPathComponent()
    let backup = environment.deletingLastPathComponent().appendingPathComponent(
      "backup-\(UUID().uuidString)")
    try files.createDirectory(
      at: environment.deletingLastPathComponent(), withIntermediateDirectories: true)
    if files.fileExists(atPath: environment.path) {
      try files.moveItem(at: environment, to: backup)
    }
    do {
      guard try await run(basePython, ["-m", "venv", environment.path]) == 0,
        try await run(
          python,
          [
            "-m", "pip", "install", "--no-index", "--find-links",
            resources.appendingPathComponent("wheels").path, "-r",
            resources.appendingPathComponent("requirements-release.txt").path,
          ]) == 0
      else { throw LauncherError.message("依赖初始化失败，请查看环境日志；原有数据不受影响。") }
      if files.fileExists(atPath: backup.path) { try files.removeItem(at: backup) }
    } catch {
      try? files.removeItem(at: environment)
      if files.fileExists(atPath: backup.path) { try? files.moveItem(at: backup, to: environment) }
      throw error
    }
  }

  func migrate(from directory: URL) async throws {
    guard
      try await run(
        python,
        [resources.appendingPathComponent("migrate_data.py").path, directory.path, data.path]) == 0
    else {
      throw LauncherError.message("导入失败：目标必须为空，源数据必须完整；详见环境日志。原目录不会删除或修改。")
    }
  }
}
