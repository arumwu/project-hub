// Project Hub のアプリ本体（Mac 用）
// - ダブルクリックで起動。ターミナルの窓は出ない
// - 本体（node server.js）が動いていなければ、自分で起動する
// - Mac 内蔵の WebKit で画面を出す
// - 何か失敗したら、黙らずに画面に理由を出す。記録は ~/Library/Logs/ProjectHub.log
import Cocoa
import WebKit

let home = FileManager.default.homeDirectoryForCurrentUser.path
let logPath = home + "/Library/Logs/ProjectHub.log"

func log(_ s: String) {
    let f = DateFormatter(); f.dateFormat = "HH:mm:ss"
    let line = "[\(f.string(from: Date()))] \(s)\n"
    try? FileManager.default.createDirectory(atPath: home + "/Library/Logs", withIntermediateDirectories: true)
    if let h = FileHandle(forWritingAtPath: logPath) {
        h.seekToEndOfFile(); h.write(line.data(using: .utf8)!); h.closeFile()
    } else {
        try? line.write(toFile: logPath, atomically: true, encoding: .utf8)
    }
}

// Info.plist に書いた本体の場所（build-app.sh が書き込む）
let hubDir = (Bundle.main.object(forInfoDictionaryKey: "HubDir") as? String) ?? (home + "/Documents/AI-Workspace/System/ProjectHub/hub")
let port = (Bundle.main.object(forInfoDictionaryKey: "HubPort") as? String) ?? "4545"
let baseURL = URL(string: "http://127.0.0.1:\(port)")!

// ログインした時と同じ PATH を取る（claude / codex / node の場所が分かるように）
func loginShellPath() -> String {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/zsh")
    p.arguments = ["-lic", "printf '%s' \"$PATH\""]
    let out = Pipe(); p.standardOutput = out; p.standardError = Pipe()
    do { try p.run() } catch { return "" }
    p.waitUntilExit()
    let s = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    // 最後の行だけ使う（シェルの挨拶などを避ける）
    return s.split(separator: "\n").last.map(String.init) ?? ""
}

func findNode(path: String) -> String? {
    var dirs = path.split(separator: ":").map(String.init)
    dirs += ["/opt/homebrew/bin", "/usr/local/bin", home + "/.volta/bin", home + "/.local/bin"]
    let nvm = home + "/.nvm/versions/node"
    if let vs = try? FileManager.default.contentsOfDirectory(atPath: nvm) {
        dirs += vs.sorted().reversed().map { nvm + "/" + $0 + "/bin" }
    }
    for d in dirs {
        let c = d + "/node"
        if FileManager.default.isExecutableFile(atPath: c) { return c }
    }
    return nil
}

// 本体が動いているか。軽い /api/ping に聞き、何か答えが返れば動いているとみなす
// （前は一覧 /api/state に1.5秒で聞いていたため、台帳が大きいと「動いていない」と間違え、2つ目を起動して失敗していた）
func serverAlive() -> Bool {
    let sem = DispatchSemaphore(value: 0)
    var ok = false
    var req = URLRequest(url: baseURL.appendingPathComponent("api/ping"))
    req.timeoutInterval = 4
    URLSession.shared.dataTask(with: req) { _, res, _ in
        ok = (res as? HTTPURLResponse) != nil
        sem.signal()
    }.resume()
    _ = sem.wait(timeout: .now() + 5)
    return ok
}
// 記録の最後の数行（止まった理由を画面に出すため）
func logTail(_ n: Int) -> String {
    guard let s = try? String(contentsOfFile: logPath, encoding: .utf8) else { return "" }
    return s.split(separator: "\n").suffix(n).joined(separator: "\n")
        .replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
}

// Mac の「ファイルとフォルダ」の許可（書類・デスクトップ・ダウンロード）
let privacyFolders: [(name: String, path: String, service: String)] = [
    ("書類", home + "/Documents", "SystemPolicyDocumentsFolder"),
    ("デスクトップ", home + "/Desktop", "SystemPolicyDesktopFolder"),
    ("ダウンロード", home + "/Downloads", "SystemPolicyDownloadsFolder"),
]
// 中を読んでみる。まだ決めていなければ、ここで Mac が「アクセスを求めています」と確認を出す
func canRead(_ dir: String) -> Bool {
    return (try? FileManager.default.contentsOfDirectory(atPath: dir)) != nil
}
// 前に選んだ答え（許可しない など）を消す。次に読んだ時、確認がもう一度出る
func resetPrivacy() {
    let id = Bundle.main.bundleIdentifier ?? "local.projecthub"
    for f in privacyFolders {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/tccutil")
        p.arguments = ["reset", f.service, id]
        do { try p.run(); p.waitUntilExit(); log("許可をやり直し: \(f.service)（\(p.terminationStatus)）") }
        catch { log("tccutil を動かせません: \(error)") }
    }
}

// 動いている本体が、台帳のフォルダを読めるか（前の起動のまま許可が効いていない時は false）
func serverCanRead() -> Bool {
    let sem = DispatchSemaphore(value: 0)
    var ok = true   // 答えが無い古い本体は、読めるものとして扱う
    var req = URLRequest(url: baseURL.appendingPathComponent("api/access"))
    req.timeoutInterval = 1.5
    URLSession.shared.dataTask(with: req) { data, res, _ in
        if (res as? HTTPURLResponse)?.statusCode == 200, let d = data,
           let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any], let v = o["ok"] as? Bool { ok = v }
        sem.signal()
    }.resume()
    _ = sem.wait(timeout: .now() + 2)
    return ok
}
// 本体を止めてもらう。AI が動いている時は断られる（false）
func quitServer() -> Bool {
    let sem = DispatchSemaphore(value: 0)
    var ok = false
    var req = URLRequest(url: baseURL.appendingPathComponent("api/quit"))
    req.httpMethod = "POST"
    req.setValue("1", forHTTPHeaderField: "X-Hub")
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = "{\"reason\":\"access\"}".data(using: .utf8)
    req.timeoutInterval = 2
    URLSession.shared.dataTask(with: req) { _, res, _ in
        ok = ((res as? HTTPURLResponse)?.statusCode == 200)
        sem.signal()
    }.resume()
    _ = sem.wait(timeout: .now() + 3)
    if !ok { return false }
    for _ in 0..<30 { if !serverAlive() { return true }; Thread.sleep(forTimeInterval: 0.2) }
    return false
}

func page(_ title: String, _ body: String) -> String {
    return """
    <!doctype html><meta charset="utf-8"><title>Project Hub</title>
    <style>body{font-family:-apple-system,"Hiragino Sans",sans-serif;background:#eef0f3;color:#1c2230;margin:0;display:grid;place-items:center;height:100vh}
    .b{background:#fff;border:1px solid #dde1e8;border-radius:12px;padding:24px 28px;max-width:560px;line-height:1.7}
    h1{font-size:18px;margin:0 0 8px}code{background:#f1f3f7;padding:2px 6px;border-radius:4px;word-break:break-all}
    @media (prefers-color-scheme:dark){body{background:#121520;color:#e6e9f0}.b{background:#1a1e29;border-color:#2c3241}code{background:#222735}}</style>
    <div class="b"><h1>\(title)</h1>\(body)</div>
    """
}

// ファイル・フォルダを落とした時、本当の場所（パス）を画面に渡す
// （Web の画面だけでは、落とした物の場所が分からないため）。スクショの一時画像など場所の無い物は、これまでどおり画面に任せる
class DropWebView: WKWebView {
    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let urls = sender.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
        if urls.isEmpty { return super.performDragOperation(sender) }
        let paths = urls.map { $0.path }
        guard let data = try? JSONSerialization.data(withJSONObject: paths), let json = String(data: data, encoding: .utf8) else { return false }
        evaluateJavaScript("window.hubNativeDrop && window.hubNativeDrop(\(json))", completionHandler: nil)
        return true
    }
}

class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var server: Process?

    func applicationDidFinishLaunching(_ n: Notification) {
        log("アプリを開きました（本体の場所: \(hubDir)）")
        let conf = WKWebViewConfiguration()
        conf.applicationNameForUserAgent = "ProjectHubApp/1"   // 画面側で「アプリの中」と分かるように
        web = DropWebView(frame: .zero, configuration: conf)
        web.navigationDelegate = self
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 860),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "Project Hub"
        window.minSize = NSSize(width: 720, height: 480)
        window.contentView = web
        window.center()
        window.setFrameAutosaveName("ProjectHubMain")
        window.makeKeyAndOrderFront(nil)
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        buildMenu()
        web.loadHTMLString(page("起動しています…", "<p>数秒お待ちください。</p>"), baseURL: nil)
        DispatchQueue.global().async { self.startAndLoad() }
    }

    func startAndLoad() {
        // 本体がもう動いていても、書類フォルダを読んでみる（許可の確認を出すため）
        let appCanRead = canRead(home + "/Documents")
        if !appCanRead { log("書類フォルダを読めません（許可が無い可能性）") }
        // 本体が前の起動のまま動いていて、許可が効いていない時は、止めてこのアプリから起動し直す
        if appCanRead && serverAlive() && !serverCanRead() {
            log("本体が書類フォルダを読めません。起動し直します")
            if !quitServer() { log("本体を止められませんでした（AI が作業中の可能性）。そのまま開きます") }
        }
        if serverAlive() {
            log("本体はすでに動いています")
            DispatchQueue.main.async { self.web.load(URLRequest(url: baseURL)) }
            return
        }
        let path = loginShellPath()
        log("PATH: \(path.isEmpty ? "（取れず）" : path)")
        guard let node = findNode(path: path) else {
            log("node が見つかりません")
            showError("Node.js が見つかりません", "<p><a href=\"https://nodejs.org\">https://nodejs.org</a> から入れてから、もう一度開いてください。</p>")
            return
        }
        let serverJS = hubDir + "/server.js"
        // 実際に読んでみる（ここで Mac が「書類フォルダへのアクセス」の確認を出す）
        if FileManager.default.contents(atPath: serverJS) == nil {
            log("本体を読めません: \(serverJS)（書類フォルダの許可が必要な可能性）")
            showError("本体のファイルを読めません",
                      "<p>「システム設定 → プライバシーとセキュリティ → ファイルとフォルダ」で、<b>Project Hub</b> の「書類フォルダ」をオンにしてから、もう一度開いてください。</p><p>場所：<code>\(serverJS)</code></p>")
            DispatchQueue.main.async {
                NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders")!)
            }
            return
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [serverJS]
        p.currentDirectoryURL = URL(fileURLWithPath: hubDir)
        var env = ProcessInfo.processInfo.environment
        let extra = [(node as NSString).deletingLastPathComponent, "/opt/homebrew/bin", "/usr/local/bin", home + "/.local/bin", home + "/.claude/local"]
        env["PATH"] = ([path] + extra + [env["PATH"] ?? "/usr/bin:/bin"]).filter { !$0.isEmpty }.joined(separator: ":")
        env["HUB_PORT"] = port
        p.environment = env
        if let h = FileHandle(forWritingAtPath: logPath) { h.seekToEndOfFile(); p.standardOutput = h; p.standardError = h }
        do {
            try p.run()
            server = p
            log("本体を起動しました（node: \(node)）")
        } catch {
            log("本体を起動できません: \(error)")
            showError("本体を起動できません", "<p>記録：<code>\(logPath)</code></p>")
            return
        }
        for _ in 0..<50 {
            if serverAlive() {
                log("本体の準備ができました")
                DispatchQueue.main.async { self.web.load(URLRequest(url: baseURL)) }
                return
            }
            if !p.isRunning { break }
            Thread.sleep(forTimeInterval: 0.3)
        }
        log("本体が応答しません（本体は\(p.isRunning ? "動いています" : "止まりました（終了コード \(p.terminationStatus)）")）")
        let busyPort = logTail(8).contains("は使われています")
        showError("本体が応答しません", (busyPort ? "<p><b>前の本体が止まったまま残っています。</b>ターミナルで <code>pkill -f ProjectHub/hub/server.js</code> を実行してから、［再読み込み］（⌘R）を押してください。</p>" : "") + "<p>メニューの［再読み込み］（⌘R）で、もう一度試せます。直らない時は、下の記録を Claude に見せてください：<code>\(logPath)</code></p><pre style=\"white-space:pre-wrap;font-size:12px;max-height:40vh;overflow:auto\">\(logTail(25))</pre>")
    }

    func showError(_ title: String, _ body: String) {
        DispatchQueue.main.async { self.web.loadHTMLString(page(title, body), baseURL: nil) }
    }

    func buildMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem(); main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "再読み込み", action: #selector(reload), keyEquivalent: "r")
        appMenu.addItem(withTitle: "記録を開く", action: #selector(openLog), keyEquivalent: "l")
        appMenu.addItem(withTitle: "ファイルの許可を確かめる…", action: #selector(checkAccess), keyEquivalent: "")
        appMenu.addItem(withTitle: "ファイルの許可をやり直す（確認をもう一度出す）…", action: #selector(redoAccess), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "Project Hub を終了", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        // 編集メニュー（コピー・貼り付けを効かせる）
        let editItem = NSMenuItem(); main.addItem(editItem)
        let edit = NSMenu(title: "編集")
        edit.addItem(withTitle: "取り消す", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "カット", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "コピー", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "ペースト", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "すべてを選択", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        NSApp.mainMenu = main
    }

    @objc func reload() {
        if serverAlive() { web.load(URLRequest(url: baseURL)) } else { DispatchQueue.global().async { self.startAndLoad() } }
    }
    @objc func openLog() { NSWorkspace.shared.open(URL(fileURLWithPath: logPath)) }

    // 画面から頼まれた場所を Finder で開く（フォルダはその中を、ファイルは選んだ状態で）
    func revealFromPage(_ u: URL) {
        let q = URLComponents(url: u, resolvingAgainstBaseURL: false)?.queryItems ?? []
        guard let p = q.first(where: { $0.name == "path" })?.value, !p.isEmpty else { return }
        let isDir = q.first(where: { $0.name == "dir" })?.value == "1"
        let url = URL(fileURLWithPath: p, isDirectory: isDir)
        // open=1：Finder を通さず、ファイルをそのアプリ（.md ならテキスト、.png ならプレビュー）で開く
        if q.first(where: { $0.name == "open" })?.value == "1" {
            let ok = NSWorkspace.shared.open(url)
            log("アプリで開く: \(p)（\(ok ? "OK" : "失敗")）")
            return
        }
        log("Finder で開く: \(p)（\(isDir ? "フォルダ" : "ファイル")）")
        // まず Finder に直接頼む（AppleScript。初回は「Finder を制御することを許可」の確認が出る）。だめなら Mac の仕組み（NSWorkspace）で
        let quoted = p.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
        let body = isDir
            ? "tell application \"Finder\"\nactivate\nopen (POSIX file \"\(quoted)\" as alias)\nend tell"
            : "tell application \"Finder\"\nactivate\nreveal (POSIX file \"\(quoted)\" as alias)\nend tell"
        var err: NSDictionary?
        if let script = NSAppleScript(source: body) {
            _ = script.executeAndReturnError(&err)
            if err == nil { log("Finder に頼みました（AppleScript）"); return }
            log("AppleScript で開けません: \(err ?? [:])")
        }
        if isDir {
            let ok = NSWorkspace.shared.open(url)
            log("NSWorkspace でフォルダを開く: \(ok ? "OK" : "失敗")")
            if !ok { NSWorkspace.shared.activateFileViewerSelecting([url]) }
        } else {
            NSWorkspace.shared.activateFileViewerSelecting([url])
            log("NSWorkspace でファイルを選ぶ形で開きました")
        }
    }
    @objc func checkAccess() { askAccess(reset: false) }
    @objc func redoAccess() { askAccess(reset: true) }

    // 許可を確かめる。reset の時は前の答えを消してから読むので、確認がもう一度出る
    func askAccess(reset: Bool) {
        DispatchQueue.global().async {
            if reset { resetPrivacy() }
            let result = privacyFolders.map { (name: $0.name, ok: canRead($0.path)) }
            log("許可: " + result.map { "\($0.name)=\($0.ok ? "あり" : "なし")" }.joined(separator: " "))
            if result.first?.ok == true && serverAlive() && !serverCanRead() {
                log("許可の後、本体を起動し直します")
                if quitServer() { self.startAndLoad() }
            }
            DispatchQueue.main.async { self.showAccess(result) }
        }
    }

    func showAccess(_ result: [(name: String, ok: Bool)]) {
        let a = NSAlert()
        a.messageText = "Mac のファイルの許可"
        let lines = result.map { "\($0.ok ? "✓" : "✕") \($0.name)フォルダ：\($0.ok ? "許可あり" : "許可なし")" }.joined(separator: "\n")
        let allOK = result.allSatisfy { $0.ok }
        a.informativeText = lines + (allOK ? "\n\nすべて使えます。" : "\n\n［確認をもう一度出す］で Mac の確認が出たら「許可」を選んでください。出ない時は［フルディスクアクセスを開く］で、表示された Project Hub をリストに入れてオンにしてください。")
        if allOK { a.addButton(withTitle: "OK"); a.runModal(); return }
        a.addButton(withTitle: "確認をもう一度出す")
        a.addButton(withTitle: "フルディスクアクセスを開く")
        a.addButton(withTitle: "閉じる")
        let r = a.runModal()
        if r == .alertFirstButtonReturn { askAccess(reset: true) }
        else if r == .alertSecondButtonReturn {
            NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")!)
            NSWorkspace.shared.activateFileViewerSelecting([Bundle.main.bundleURL])   // リストに落として入れられるように
        }
    }

    // 窓を閉じたら終了。本体（と作業中の AI）は裏で動き続ける
    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { true }

    // 外のサイトへのリンクは通常のブラウザで開く
    func webView(_ w: WKWebView, decidePolicyFor a: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // 画面の設定から：hubapp://access（確かめる）／ hubapp://access?reset=1（確認をもう一度出す）
        if let u = a.request.url, u.scheme == "hubapp" {
            if u.host == "access" { askAccess(reset: (u.query ?? "").contains("reset=1")) }
            if u.host == "reveal" { revealFromPage(u) }
            decisionHandler(.cancel); return
        }
        if let u = a.request.url, let host = u.host, host != "127.0.0.1", host != "localhost",
           let scheme = u.scheme, scheme.hasPrefix("http") {
            NSWorkspace.shared.open(u); decisionHandler(.cancel); return
        }
        decisionHandler(.allow)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
