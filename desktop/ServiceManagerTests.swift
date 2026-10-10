import Foundation

@main
struct ServiceManagerTests {
  @MainActor static func main() async {
    let args = CommandLine.arguments
    let root = URL(fileURLWithPath: args[1])
    let node = URL(fileURLWithPath: args[2])
    let backendPort = Int(args[3])!
    let frontendPort = Int(args[4])!
    func manager(_ directory: URL? = nil) -> ServiceManager {
      ServiceManager(
        root: directory ?? root, node: node, backendPort: backendPort,
        frontendPort: frontendPort, logDirectory: root.appendingPathComponent("logs"))
    }
    func check(_ condition: Bool, _ message: String) throws {
      if !condition { throw LauncherError.message("TEST FAILED: \(message)") }
    }
    let owner = manager()
    let external = Process()
    do {
      let environmentResources = root.appendingPathComponent("environment-resources")
      try FileManager.default.createDirectory(
        at: environmentResources, withIntermediateDirectories: true)
      try "py312-test".write(
        to: environmentResources.appendingPathComponent("environment-id"), atomically: true,
        encoding: .utf8)
      let noPython = try RuntimeEnvironment(
        resources: environmentResources,
        supportDirectory: root.appendingPathComponent("environment-support"),
        pythonCandidates: [], officeCandidates: ["/usr/bin/true"])
      let missingPython = await noPython.detect()
      try check(
        missingPython?.contains("Python") == true, "missing Python has actionable diagnostic")
      try check(
        noPython.basePython == nil && !noPython.dependenciesReady,
        "missing environment not marked ready")
      try check(noPython.libreOffice != nil, "LibreOffice is still detected when Python is missing")
      let noOffice = try RuntimeEnvironment(
        resources: environmentResources,
        supportDirectory: root.appendingPathComponent("empty-support"),
        pythonCandidates: [], officeCandidates: [])
      _ = await noOffice.detect()
      try check(noOffice.libreOffice == nil, "missing LibreOffice not marked installed")
      let brokenOffice = try RuntimeEnvironment(
        resources: environmentResources,
        supportDirectory: root.appendingPathComponent("broken-support"),
        pythonCandidates: [], officeCandidates: ["/usr/bin/false"])
      _ = await brokenOffice.detect()
      try check(brokenOffice.libreOffice == nil, "non-running LibreOffice not marked installed")
      print("PASS: independent environment diagnostics and non-running dependency detection")
      let output = root.appendingPathComponent("export.docx")
      let fresh = DownloadFile(destination: output)
      try Data("new".utf8).write(to: fresh.temporary)
      try fresh.finish()
      try check(try String(contentsOf: output, encoding: .utf8) == "new", "new export saved")
      let replacement = DownloadFile(destination: output)
      try Data("replacement".utf8).write(to: replacement.temporary)
      try replacement.finish()
      try check(
        try String(contentsOf: output, encoding: .utf8) == "replacement",
        "confirmed replacement saved")
      let cancelled = DownloadFile(destination: output)
      try Data("partial".utf8).write(to: cancelled.temporary)
      cancelled.cleanup()
      try check(
        try String(contentsOf: output, encoding: .utf8) == "replacement",
        "failed download preserves original")
      let race = DownloadFile(destination: root.appendingPathComponent("race.docx"))
      try Data("external".utf8).write(to: race.destination)
      try Data("download".utf8).write(to: race.temporary)
      do {
        try race.finish()
        throw LauncherError.message("unconfirmed overwrite accepted")
      } catch let error as CocoaError {
        try check(error.code == .fileWriteFileExists, "concurrent file creation protected")
      }
      race.cleanup()
      try check(
        try String(contentsOf: race.destination, encoding: .utf8) == "external",
        "concurrent file unchanged")
      print("PASS: export save, replacement, cancellation and concurrent file protection")
      do {
        try await manager(root.appendingPathComponent("missing")).start()
        throw LauncherError.message("missing project accepted")
      } catch {
        try check(error.localizedDescription.contains("项目目录无效"), "missing project diagnostic")
      }
      try await owner.start()
      try check(owner.ownedCount == 2, "owns exactly two direct children")
      let pids = owner.children.values.map { $0.processIdentifier }
      let reuser = manager()
      try await reuser.start()
      try check(reuser.ownedCount == 0, "existing services are reused")
      await reuser.stop()
      try check(
        owner.children.values.allSatisfy { $0.isRunning }, "stop never kills reused services")
      try check(
        owner.children.values.map { $0.processIdentifier }.sorted() == pids.sorted(),
        "reused PIDs preserved")
      let other = manager(root.appendingPathComponent("another-checkout"))
      try check(await other.probe(true) == .foreign, "different checkout is rejected")
      await owner.stop()
      try check(owner.ownedCount == 0, "owned services stop")
      try check(await owner.probe(true) == .closed, "backend port released")
      try check(await owner.probe(false) == .closed, "frontend port released")
      print("PASS: startup, reuse, ownership, checkout identity, graceful stop")
      try "static resources".write(
        to: root.appendingPathComponent("frontend/index.html"), atomically: true, encoding: .utf8)
      let packaged = ServiceManager(
        resources: root, python: root.appendingPathComponent("backend/.venv/bin/python"),
        dataDirectory: root.appendingPathComponent("Data"), backendPort: backendPort)
      try await packaged.start()
      try check(packaged.ownedCount == 1, "packaged app only owns Python backend")
      try check(packaged.pageURL.port == backendPort, "packaged workbench uses backend origin")
      let wrongData = ServiceManager(
        resources: root, python: root.appendingPathComponent("backend/.venv/bin/python"),
        dataDirectory: root.appendingPathComponent("other-data"), backendPort: backendPort)
      try check(
        await wrongData.probe(true) == .foreign, "different data directory cannot be reused")
      await packaged.stop()
      try check(await packaged.probe(true) == .closed, "packaged stop releases service")
      print("PASS: packaged resources, single-service ownership and data identity")

      _ = FileManager.default.createFile(
        atPath: root.appendingPathComponent("foreign.flag").path, contents: nil)
      external.executableURL = node
      external.arguments = [
        root.appendingPathComponent("frontend/node_modules/vite/bin/vite.js").path,
        "--port", String(frontendPort),
      ]
      external.currentDirectoryURL = root.appendingPathComponent("frontend")
      external.standardOutput = FileHandle.nullDevice
      external.standardError = FileHandle.nullDevice
      try external.run()
      for _ in 0..<30 {
        if await owner.probe(false) == .foreign { break }
        try await Task.sleep(nanoseconds: 100_000_000)
      }
      do {
        try await owner.start()
        throw LauncherError.message("foreign service accepted")
      } catch { try check(error.localizedDescription.contains("端口"), "port conflict diagnostic") }
      try check(external.isRunning && owner.ownedCount == 0, "foreign listener untouched")
      external.terminate()
      external.waitUntilExit()
      try FileManager.default.removeItem(at: root.appendingPathComponent("foreign.flag"))
      print("PASS: foreign port protection")

      _ = FileManager.default.createFile(
        atPath: root.appendingPathComponent("fail.flag").path, contents: nil)
      do {
        try await owner.start()
        throw LauncherError.message("failed frontend accepted")
      } catch { try check(error.localizedDescription.contains("启动失败"), "failed launch diagnostic") }
      try check(owner.ownedCount == 0, "partial startup is rolled back")
      print("PASS: partial startup rollback")
      exit(0)
    } catch {
      await owner.stop()
      if external.isRunning {
        external.terminate()
        external.waitUntilExit()
      }
      fputs("\(error.localizedDescription)\n", stderr)
      exit(1)
    }
  }
}
