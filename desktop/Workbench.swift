import AppKit
import WebKit

/// The existing Vue workbench runs in an ordinary macOS window. No document
/// rendering or data storage pipeline is duplicated in the native shell.
@MainActor
final class WorkbenchWindow: NSObject, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
  let window: NSWindow
  private let webView: WKWebView
  private let message = NSTextField(wrappingLabelWithString: "正在启动本地文档服务…")
  private var pageURL: URL?
  private var downloads: [WKDownload] = []
  private var destinations: [ObjectIdentifier: DownloadFile] = [:]

  override init() {
    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1180, height: 800),
      styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false
    )
    webView = WKWebView(frame: .zero)
    super.init()
    window.title = "模块化文档生成助手"
    window.minSize = NSSize(width: 680, height: 480)
    window.isReleasedWhenClosed = false
    window.center()
    guard let content = window.contentView else { return }
    webView.frame = content.bounds
    webView.autoresizingMask = [.width, .height]
    webView.navigationDelegate = self
    webView.uiDelegate = self
    webView.isHidden = true
    content.addSubview(webView)
    message.frame = NSRect(x: 32, y: content.bounds.height / 2, width: 600, height: 80)
    message.autoresizingMask = [.minYMargin, .maxYMargin]
    message.font = .systemFont(ofSize: 16)
    content.addSubview(message)
  }

  func show() {
    window.makeKeyAndOrderFront(nil)
    NSApp.activate()
  }

  func showMessage(_ text: String) {
    message.stringValue = text
    message.isHidden = false
  }

  func load(_ url: URL) {
    if pageURL == url && webView.url != nil { return }
    pageURL = url
    showMessage("正在打开工作台…")
    webView.load(URLRequest(url: url))
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    webView.isHidden = false
    message.isHidden = true
  }

  func webView(
    _ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
    withError error: Error
  ) {
    if (error as NSError).code == NSURLErrorCancelled { return }
    showMessage("工作台加载失败：\(error.localizedDescription)\n可从菜单打开服务管理，再点击「打开工作台」重试。")
    pageURL = nil
  }

  func webView(
    _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    guard let url = navigationAction.request.url else {
      decisionHandler(.cancel)
      return
    }
    // Blob exports originate in the trusted workbench; arbitrary websites never
    // replace the document editor. PDF workers fetch assets without navigation.
    if navigationAction.shouldPerformDownload {
      decisionHandler(isLocal(url) || url.scheme == "blob" ? .download : .cancel)
    } else if isLocal(url) || url.scheme == "about" {
      decisionHandler(.allow)
    } else {
      if url.scheme == "https" || url.scheme == "http" { NSWorkspace.shared.open(url) }
      decisionHandler(.cancel)
    }
  }

  private func isLocal(_ url: URL) -> Bool {
    guard let pageURL else { return false }
    return url.scheme == pageURL.scheme && url.host == pageURL.host && url.port == pageURL.port
  }

  func webView(
    _ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
    decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
  ) {
    decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
  }

  func webView(
    _ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload
  ) { attach(download) }

  func webView(
    _ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload
  ) { attach(download) }

  private func attach(_ download: WKDownload) {
    downloads.append(download)
    download.delegate = self
  }

  func download(
    _ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
    completionHandler: @escaping (URL?) -> Void
  ) {
    let panel = NSSavePanel()
    panel.nameFieldStringValue = URL(fileURLWithPath: suggestedFilename).lastPathComponent
    panel.canCreateDirectories = true
    panel.beginSheetModal(for: window) { [weak self] result in
      guard result == .OK, let url = panel.url, let self else {
        completionHandler(nil)
        self?.downloads.removeAll { $0 === download }
        return
      }
      let file = DownloadFile(destination: url)
      self.destinations[ObjectIdentifier(download)] = file
      completionHandler(file.temporary)

    }
  }

  func downloadDidFinish(_ download: WKDownload) {
    downloads.removeAll { $0 === download }
    guard let file = destinations.removeValue(forKey: ObjectIdentifier(download)) else { return }
    do { try file.finish() } catch {
      file.cleanup()
      showSaveError(error)
    }
  }

  func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
    downloads.removeAll { $0 === download }
    destinations.removeValue(forKey: ObjectIdentifier(download))?.cleanup()
    if (error as NSError).code == NSURLErrorCancelled { return }
    showSaveError(error)
  }

  private func showSaveError(_ error: Error) {
    let alert = NSAlert()
    alert.messageText = "导出保存失败"
    alert.informativeText = error.localizedDescription
    alert.beginSheetModal(for: window)
  }

  func webView(
    _ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
    initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void
  ) {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = parameters.allowsDirectories
    panel.canChooseFiles = true
    panel.allowsMultipleSelection = parameters.allowsMultipleSelection
    panel.beginSheetModal(for: window) { result in
      completionHandler(result == .OK ? panel.urls : nil)
    }
  }

  func webView(
    _ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
    initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void
  ) {
    let alert = NSAlert()
    alert.messageText = message
    alert.addButton(withTitle: "确定")
    alert.addButton(withTitle: "取消")
    alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
  }

  func webView(
    _ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
    initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void
  ) {
    let alert = NSAlert()
    alert.messageText = message
    alert.beginSheetModal(for: window) { _ in completionHandler() }
  }
}

/// Download to a unique sibling first: WebKit requires a nonexistent file.
/// Preserve the previous export if download fails; replace only after completion
/// and only when NSSavePanel already confirmed replacing an existing file.
struct DownloadFile {
  let destination: URL
  let temporary: URL
  let allowsReplacement: Bool

  init(destination: URL) {
    self.destination = destination
    temporary = destination.deletingLastPathComponent().appendingPathComponent(
      ".modudoc-\(UUID().uuidString).download")
    allowsReplacement = FileManager.default.fileExists(atPath: destination.path)
  }

  func finish() throws {
    let files = FileManager.default
    if files.fileExists(atPath: destination.path) {
      guard allowsReplacement else { throw CocoaError(.fileWriteFileExists) }
      _ = try files.replaceItemAt(destination, withItemAt: temporary)
    } else {
      try files.moveItem(at: temporary, to: destination)
    }
  }

  func cleanup() {
    try? FileManager.default.removeItem(at: temporary)
  }
}
