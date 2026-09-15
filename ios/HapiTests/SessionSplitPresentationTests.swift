import HapiClient
import HapiProtocol
import Observation
import SwiftUI
import UIKit
import XCTest
@testable import Hapi
@testable import HapiUI

/// Runs on a real iPad simulator, using the production split shell and list.
/// No pairing, saved credentials or live hub: HTTP is faked, SSE uses closed
/// loopback. Synthetic detail pages exercise native nested navigation; the
/// chat test renders the real ChatView/composer/anchored transcript.
@MainActor
final class SessionSplitPresentationTests: XCTestCase {
    private enum Page: Hashable { case files }

    @Observable fileprivate final class Probe {
        var instances: [String: UUID] = [:]
    }

    /// SwiftUI accessibility elements need not be UIViews. Use native probes
    /// for app-hosted presence assertions rather than treating AX IDs as views.
    private struct Presence: UIViewRepresentable {
        let id: String
        func makeUIView(context: Context) -> UIView {
            let view = UIView()
            view.accessibilityIdentifier = id
            return view
        }
        func updateUIView(_ view: UIView, context: Context) { view.accessibilityIdentifier = id }
    }

    private struct DetailProbe: View {
        let sessionId: String
        let probe: Probe
        @State private var instance = UUID()
        @State private var draft = ""

        var body: some View {
            Form {
                Text(verbatim: sessionId).accessibilityIdentifier("detail-\(sessionId)")
                TextField("Draft", text: $draft)
                NavigationLink("Files", value: Page.files)
            }
            .navigationTitle(Text(verbatim: sessionId))
            .overlay { Presence(id: "detail-\(sessionId)").frame(width: 1, height: 1).allowsHitTesting(false) }
            .navigationDestination(for: Page.self) { _ in
                Text("Files")
                    .overlay { Presence(id: "detail-files").frame(width: 1, height: 1).allowsHitTesting(false) }
            }
            .onAppear { probe.instances[sessionId] = instance }
        }
    }

    private struct Harness: View {
        let navigation: SessionNavigationState
        let list: SessionListModel
        let probe: Probe

        var body: some View {
            SessionSplitView(navigation: navigation, onNewSession: { navigation.open("created") }) {
                SessionListView(model: list, selection: Binding(
                    get: { navigation.selectedSessionId },
                    set: { if let id = $0 { navigation.open(id) } }
                ), onOpenSession: navigation.open)
                .navigationTitle("Sessions")
                .overlay { Presence(id: "home.sessions").frame(width: 1, height: 1).allowsHitTesting(false) }
            } detail: { id in
                DetailProbe(sessionId: id, probe: probe)
            }
            .hapiTypography()
            .hapiTheme(.light)
        }
    }

    func testWideSelectionSurvivesFilteringAndNestedNavigationAcrossCollapse() async throws {
        try requireIPad()
        let navigation = SessionNavigationState()
        let probe = Probe()
        let sessions = HomeFilterTestSessions([
            HomeFilterTestData.summary("a", machine: "mac"),
            HomeFilterTestData.summary("b", machine: "debian"),
        ])
        let list = HomeFilterTestData.model(sessions: sessions)
        let (window, host) = try makeWindow(Harness(navigation: navigation, list: list, probe: probe),
                                          width: 1194, height: 834)
        defer { window.isHidden = true }
        try await settle { list.hasRefreshedOnce }
        XCTAssertTrue(probe.instances.isEmpty, "An empty detail must not start/mark a chat read")
        let split = try XCTUnwrap(findController(UISplitViewController.self, in: host))
        XCTAssertFalse(split.isCollapsed)

        navigation.open("a")
        try await settle { probe.instances["a"] != nil }
        let identity = try XCTUnwrap(probe.instances["a"])
        let sidebar = try XCTUnwrap(split.viewController(for: .primary).flatMap { self.findCollection(in: $0.view) })
        XCTAssertGreaterThanOrEqual(sidebar.bounds.width, 280)
        XCTAssertLessThanOrEqual(sidebar.bounds.width, 360)

        list.selectMachine("debian")
        try await settle { list.rows.map(\.id) == ["b"] }
        XCTAssertEqual(navigation.selectedSessionId, "a")
        navigation.detailPath.append(Page.files)
        try await settle { self.findView("detail-files", in: window) != nil }
        resize(window, host: host, width: 390, height: 844, compact: true)
        try await settle { split.isCollapsed }
        XCTAssertEqual(navigation.selectedSessionId, "a")
        XCTAssertEqual(navigation.detailPath.count, 1)
        XCTAssertNotNil(findView("detail-files", in: window))

        resize(window, host: host, width: 1194, height: 834, compact: false)
        try await settle { !split.isCollapsed }
        navigation.detailPath.removeLast()
        try await settle { self.findView("detail-a", in: window) != nil }
        XCTAssertEqual(probe.instances["a"], identity)
        XCTAssertEqual(list.activeMachineFilter, "debian")
        // Neither filtering nor geometry should refresh the sidebar again.
        XCTAssertEqual(sessions.refreshCount, 1)
    }

    func testCompactProgrammaticOpenAndBackAfterAFilePush() async throws {
        try requireIPad()
        let navigation = SessionNavigationState()
        let probe = Probe()
        let list = HomeFilterTestData.model(sessions: HomeFilterTestSessions([
            HomeFilterTestData.summary("a", machine: nil), HomeFilterTestData.summary("b", machine: nil),
        ]))
        let (window, host) = try makeWindow(Harness(navigation: navigation, list: list, probe: probe),
                                          width: 390, height: 844, compact: true)
        defer { window.isHidden = true }
        let split = try XCTUnwrap(findController(UISplitViewController.self, in: host))
        try await settle { split.isCollapsed }
        // A notification/new session need not have a matching sidebar row.
        navigation.open("not-in-list")
        try await settle { self.findView("detail-not-in-list", in: window) != nil }
        navigation.detailPath.append(Page.files)
        try await settle { self.findView("detail-files", in: window) != nil }
        navigation.detailPath.removeLast()
        try await settle { self.findView("detail-not-in-list", in: window) != nil }
        try nativeBack(in: host)
        try await settle { self.findView("home.sessions", in: window) != nil }
        navigation.open("b")
        try await settle { self.findView("detail-b", in: window) != nil }
        XCTAssertEqual(navigation.selectedSessionId, "b")
        XCTAssertTrue(navigation.detailPath.isEmpty)
        navigation.remove("b")
        try await settle { self.findView("home.sessions", in: window) != nil }
        XCTAssertNil(navigation.selectedSessionId)
    }

    private struct ChatHarness: View {
        let navigation: SessionNavigationState
        let list: SessionListModel
        let hub: HubSession
        let model: ChatModel

        var body: some View {
            SessionSplitView(navigation: navigation, onNewSession: {}) {
                SessionListView(model: list, selection: Binding(
                    get: { navigation.selectedSessionId },
                    set: { if let id = $0 { navigation.open(id) } }
                ), onOpenSession: navigation.open)
                .navigationTitle("Sessions")
            } detail: { _ in
                ChatView(session: hub, model: model)
            }
            .hapiTypography()
            .hapiTheme(.light)
        }
    }

    func testRootRoutesNotificationsRemovalsAndHubSwitches() async throws {
        try requireIPad()
        let suite = "ipad-root-\(UUID())"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let registry = HubRegistry(defaults: defaults)
        let credentials = InMemoryCredentialStore()
        let payload = Data(#"{"uid":1,"exp":4102444800,"ns":"test"}"#.utf8).base64EncodedString()
        for url in ["http://127.0.0.1:1", "http://127.0.0.1:2"] {
            registry.register(url)
            try credentials.store(HubCredentials(hubUrl: url, accessToken: "test", jwt: "e30.\(payload).test"))
        }
        let model = AppModel(registry: registry, credentialStore: credentials, performer: SplitTestHTTP())
        let firstHub = try XCTUnwrap(model.session)
        let (window, host) = try makeWindow(RootView().environment(model), width: 1194, height: 834)
        defer { window.isHidden = true; model.session?.shutdown(); firstHub.shutdown() }
        try await settle { firstHub.sessionStore.sessions.count == 2 }
        XCTAssertNil(firstHub.openChatSessionId)
        XCTAssertNil(findController(TranscriptCollectionController<TranscriptRow>.self, in: host))
        model.pendingOpenSessionId = "a"
        try await settle { firstHub.openChatSessionId == "a" && self.findController(TranscriptCollectionController<TranscriptRow>.self, in: host) != nil }
        XCTAssertNil(model.pendingOpenSessionId)
        try capture(window, name: "ipad-home")
        host.overrideUserInterfaceStyle = .dark
        try await settle { host.traitCollection.userInterfaceStyle == .dark }
        try capture(window, name: "ipad-home-dark")

        firstHub.sessionStore.applySessionEvent(.sessionRemoved(namespace: nil, sessionId: "b"))
        try await Task.sleep(for: .milliseconds(250))
        XCTAssertEqual(firstHub.openChatSessionId, "a")
        firstHub.sessionStore.applySessionEvent(.sessionRemoved(namespace: nil, sessionId: "a"))
        try await settle { firstHub.openChatSessionId == nil }
        XCTAssertNil(findController(TranscriptCollectionController<TranscriptRow>.self, in: host))

        model.switchHub(to: "http://127.0.0.1:2")
        let secondHub = try XCTUnwrap(model.session)
        try await settle { secondHub.sessionStore.sessions.count == 2 }
        XCTAssertNil(secondHub.openChatSessionId)
        model.pendingOpenSessionId = "b"
        try await settle { secondHub.openChatSessionId == "b" }
        XCTAssertNil(firstHub.openChatSessionId)
    }

    func testRealChatResizePreservesTranscriptDraftAttachmentsAndSingleSurface() async throws {
        try requireIPad()
        let credentials = InMemoryCredentialStore()
        let payload = Data(#"{"uid":1,"exp":4102444800,"ns":"test"}"#.utf8).base64EncodedString()
        try credentials.store(HubCredentials(hubUrl: "http://127.0.0.1:1", accessToken: "test", jwt: "e30.\(payload).test"))
        let http = SplitTestHTTP()
        let hub = try XCTUnwrap(HubSession(hubUrl: "http://127.0.0.1:1/ipad-chat-\(UUID())",
                                         credentialStore: credentials, performer: http))
        let model = ChatModel(session: hub, sessionId: "a")
        let navigation = SessionNavigationState()
        navigation.open("a")
        let sessions = HomeFilterTestSessions([
            HomeFilterTestData.summary("a", machine: "mac"), HomeFilterTestData.summary("b", machine: "debian"),
        ])
        let list = HomeFilterTestData.model(sessions: sessions)
        let (window, host) = try makeWindow(ChatHarness(navigation: navigation, list: list, hub: hub, model: model),
                                          width: 1194, height: 834)
        defer { window.isHidden = true; model.stop(); hub.shutdown() }
        try await settle { !model.isInitialLoading && !model.blocks.isEmpty && !model.isSyncingTail }
        let transcript = try XCTUnwrap(findController(TranscriptCollectionController<TranscriptRow>.self, in: host))
        let collection = try XCTUnwrap(findCollection(in: transcript.view))
        model.interactor.setComposerText("检查 iPad 分栏与窗口缩放；这段草稿不能丢失。")
        model.interactor.attachments.add(PreparedAttachment(filename: "layout.txt", mimeType: "text/plain", bytes: Data("iPad".utf8)))
        try await settle { model.interactor.attachments.items.first?.status == .ready }
        let attachment = try XCTUnwrap(model.interactor.attachments.items.first)
        let requests = await http.messageRequests
        try capture(window, name: "ipad-wide")

        collection.delegate?.scrollViewWillBeginDragging?(collection)
        collection.scrollToItem(at: IndexPath(item: 20, section: 0), at: .top, animated: false)
        try await settle { !model.followsTail }
        let cell = try XCTUnwrap(collection.cellForItem(at: IndexPath(item: 20, section: 0)))
        let anchorID = cell.accessibilityIdentifier
        let anchorY = cell.frame.minY - collection.contentOffset.y

        for (width, height, compact) in [(820.0, 1180.0, false), (600, 900, false), (390, 844, true), (1194, 834, false)] {
            resize(window, host: host, width: width, height: height, compact: compact)
            try await settle { self.findController(TranscriptCollectionController<TranscriptRow>.self, in: host) != nil }
            XCTAssertTrue(findController(TranscriptCollectionController<TranscriptRow>.self, in: host) === transcript)
            let restored = try XCTUnwrap(collection.visibleCells.first { $0.accessibilityIdentifier == anchorID })
            XCTAssertEqual(restored.frame.minY - collection.contentOffset.y, anchorY, accuracy: 2)
            XCTAssertEqual(model.interactor.composerText, "检查 iPad 分栏与窗口缩放；这段草稿不能丢失。")
            XCTAssertEqual(model.interactor.attachments.items.first?.id, attachment.id)
            XCTAssertEqual(model.visibleSurfaces, ["chat"])
            XCTAssertEqual(hub.openChatSessionId, "a")
            let rowWidth = try XCTUnwrap(collection.layoutAttributesForItem(at: IndexPath(item: 20, section: 0))).size.width
            XCTAssertLessThanOrEqual(rowWidth, 720)
            if compact { try capture(window, name: "ipad-compact") }
        }
        navigation.columnVisibility = .detailOnly
        try await settle { collection.bounds.width > 1000 }
        navigation.columnVisibility = .all
        try await settle { collection.bounds.width < 1000 }
        XCTAssertTrue(findController(TranscriptCollectionController<TranscriptRow>.self, in: host) === transcript)
        let finalRequests = await http.messageRequests
        XCTAssertEqual(finalRequests, requests, "Geometry must not cold-start the chat's message window")
        XCTAssertEqual(sessions.refreshCount, 1)

        // A genuinely hidden chat must stop claiming visibility/marking read,
        // unlike a detail that only moved during a window resize.
        resize(window, host: host, width: 390, height: 844, compact: true)
        try await settle { self.findController(UISplitViewController.self, in: host)?.isCollapsed == true }
        try nativeBack(in: host)
        try await settle { model.visibleSurfaces.isEmpty && hub.openChatSessionId == nil }
        navigation.open("a")
        try await settle { model.visibleSurfaces == ["chat"] && hub.openChatSessionId == "a" }
        XCTAssertEqual(model.interactor.attachments.items.first?.id, attachment.id)
    }

    private func requireIPad() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .pad, "Run with HAPI_TEST_DEVICE_TYPE=iPad-Air-11-inch-M2")
    }

    private func makeWindow<V: View>(_ view: V, width: CGFloat, height: CGFloat, compact: Bool = false) throws -> (UIWindow, UIHostingController<V>) {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        let host = UIHostingController(rootView: view)
        window.rootViewController = host
        resize(window, host: host, width: width, height: height, compact: compact)
        window.makeKeyAndVisible()
        host.view.layoutIfNeeded()
        return (window, host)
    }

    private func resize(_ window: UIWindow, host: UIViewController, width: CGFloat, height: CGFloat, compact: Bool) {
        host.traitOverrides.horizontalSizeClass = compact ? .compact : .regular
        window.frame = CGRect(x: 0, y: 0, width: width, height: height)
        window.layoutIfNeeded()
        host.view.layoutIfNeeded()
    }

    private func settle(_ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        for _ in 0..<150 {
            try await Task.sleep(for: .milliseconds(20))
            if condition() {
                try await Task.sleep(for: .milliseconds(350))
                return
            }
        }
        XCTFail("iPad navigation/layout did not settle", file: file, line: line)
    }

    private func findView(_ id: String, in view: UIView) -> UIView? {
        guard !view.isHidden else { return nil }
        if view.accessibilityIdentifier == id { return view }
        return view.subviews.lazy.compactMap { self.findView(id, in: $0) }.first
    }

    private func findCollection(in view: UIView) -> UICollectionView? {
        if let result = view as? UICollectionView { return result }
        return view.subviews.lazy.compactMap { self.findCollection(in: $0) }.first
    }

    private func findController<T: UIViewController>(_ type: T.Type, in controller: UIViewController) -> T? {
        if let result = controller as? T { return result }
        return controller.children.lazy.compactMap { self.findController(type, in: $0) }.first
    }

    private func nativeBack(in controller: UIViewController) throws {
        func navigations(_ parent: UIViewController) -> [UINavigationController] {
            ((parent as? UINavigationController).map { [$0] } ?? [])
                + parent.children.flatMap(navigations)
        }
        let navigation = try XCTUnwrap(navigations(controller).last {
            $0.view.window != nil && $0.viewControllers.count > 1
        })
        XCTAssertNotNil(navigation.popViewController(animated: true))
    }

    private func capture(_ window: UIWindow, name: String) throws {
        guard let path = ProcessInfo.processInfo.environment["HAPI_IPAD_CAPTURE"] else { return }
        let directory = URL(fileURLWithPath: path, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        try XCTUnwrap(image.pngData()).write(to: directory.appendingPathComponent("\(name).png"))
    }
}

private actor SplitTestHTTP: HTTPPerforming {
    private(set) var messageRequests = 0

    func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let url = try XCTUnwrap(request.url)
        var status = 200
        let data: Data
        switch url.lastPathComponent {
        case "messages":
            messageRequests += 1
            let rows = (1...80).map { index in
                DecryptedMessage(id: "message-\(index)", seq: index,
                    content: ["role": "agent", "content": ["type": "codex", "data": [
                        "type": "message", "message": .string("布局检查 \(index) · iPad workspace\n\n" + String(repeating: "Keep the conversation readable while resizing the window. ", count: 3))
                    ]]], createdAt: index * 1000, invokedAt: index * 1000)
            }
            data = try JSONEncoder().encode(MessagesResponse(messages: rows, page: MessagesPage(
                direction: .latest, limit: 200, epoch: 1, reset: false,
                nextBeforeSeq: 1, nextBeforeAt: 1000, snapshotHeadSeq: 80, snapshotHeadAt: 80000, hasMore: false
            )))
        case "a", "b":
            data = try JSONEncoder().encode(["session": sample(url.lastPathComponent)])
        case "sessions":
            data = try JSONEncoder().encode(["sessions": ["a", "b"].map { SummaryPatching.toSessionSummary(sample($0)) }])
        case "machines":
            data = Data(#"{"machines":[]}"#.utf8)
        case "upload":
            data = Data(#"{"success":true,"path":"/tmp/layout.txt"}"#.utf8)
        case "delete":
            data = Data(#"{"success":true}"#.utf8)
        default:
            status = 404
            data = Data(#"{"error":"unused test endpoint"}"#.utf8)
        }
        return (data, try XCTUnwrap(HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)))
    }

    private func sample(_ id: String) -> Session {
        Session(id: id, namespace: "test", seq: 1, createdAt: 0, updatedAt: Int(Date.now.timeIntervalSince1970 * 1000),
            active: true, activeAt: 80000,
            metadata: SessionMetadata(path: "/workspace/hapi", host: "Mac", name: id == "a" ? "iPad 布局适配" : "Review navigation tests",
                                      machineId: id == "a" ? "mac" : "debian", flavor: "codex"),
            metadataVersion: 1, agentStateVersion: 1, thinking: false, thinkingAt: 0)
    }
}
