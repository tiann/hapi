import HapiClient
import HapiUI
import Observation
import SwiftUI
import UIKit
import XCTest
@testable import Hapi
@testable import HapiProtocol

/// Actual approval cards over deterministic HTTP; never activates a real chat,
/// reads Keychain credentials, or sends a permission decision to a hub.
@MainActor
final class PermissionActionPresentationTests: XCTestCase {
    @Observable @MainActor
    final class Driver {
        var tool: ChatToolCall
        var notice: String?
        let http: ApprovalHTTP
        let store: SessionListStore
        let interactor: ChatInteractor
        @ObservationIgnored var height: CGFloat = 0
        @ObservationIgnored var appearances = 0

        init(flavor: String = "claude", toolName: String = "Bash") async throws {
            let input: JSONValue = .object(["command": .string("git diff -- ios/Hapi")])
            tool = ChatToolCall(id: "tool", name: toolName, state: .pending, input: input,
                               createdAt: 0, permission: ToolPermission(id: "approval", status: .pending))
            let session = Session(
                id: "approval-test", namespace: "test", seq: 1, createdAt: 0, updatedAt: 0,
                active: true, activeAt: 0,
                metadata: SessionMetadata(path: "/workspace/hapi", host: "test", flavor: flavor),
                metadataVersion: 1,
                agentState: AgentState(requests: ["approval": AgentStateRequest(tool: toolName, arguments: input)]),
                agentStateVersion: 1, thinking: false, thinkingAt: 0
            )
            http = ApprovalHTTP(session: session)
            let url = try XCTUnwrap(URL(string: "http://127.0.0.1:1"))
            let credentials = InMemoryCredentialStore()
            let payload = Data(#"{"uid":1,"exp":4102444800,"ns":"test"}"#.utf8).base64EncodedString()
            try credentials.store(HubCredentials(hubUrl: url.absoluteString, accessToken: "test", jwt: "e30.\(payload).test"))
            let auth = AuthManager(baseURL: url, credentialStore: credentials, performer: http)
            let api = APIClient(baseURL: url, authManager: auth, performer: http)
            store = SessionListStore(api: api)
            try await store.loadSessionDetail(session.id)
            interactor = ChatInteractor(sessionId: session.id, api: api, sessionStore: store,
                                        windows: MessageWindowControllers(provider: api))
            interactor.onEvent = { [weak self] event in
                if case .notice(let notice) = event { self?.notice = notice }
            }
        }

        var block: ToolCallBlock {
            ToolCallBlock(id: tool.id, localId: nil, createdAt: 0, invokedAt: nil,
                          durationMs: nil, usage: nil, model: nil, tool: tool, children: [], meta: nil)
        }

        func settlePermission(_ status: ToolPermissionStatus) {
            store.applySessionEvent(.sessionUpdated(namespace: nil, sessionId: "approval-test", data: .patch(SessionPatch(
                agentState: VersionedValue(version: 2, value: AgentState(requests: [:]))
            ))))
            tool.permission = ToolPermission(id: "approval", status: status)
            tool.state = .completed
        }
    }

    actor ApprovalHTTP: HTTPPerforming {
        struct Post: Sendable {
            let path: String
            let body: String?
        }
        let session: Session
        var status = 200
        var held = false
        var waiters: [CheckedContinuation<Void, Never>] = []
        private(set) var posts: [Post] = []

        init(session: Session) { self.session = session }
        func setStatus(_ value: Int) { status = value }
        func hold() { held = true }
        func release() {
            held = false
            let pending = waiters
            waiters.removeAll()
            pending.forEach { $0.resume() }
        }

        func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
            let url = try XCTUnwrap(request.url)
            let data: Data
            var responseStatus = 200
            if request.httpMethod == "POST", url.path.contains("/permissions/") {
                posts.append(Post(path: url.path, body: request.httpBody.map { String(decoding: $0, as: UTF8.self) }))
                if held { await withCheckedContinuation { waiters.append($0) } }
                responseStatus = status
                data = Data((status == 200 ? #"{"ok":true}"# : #"{"error":"Approval failed"}"#).utf8)
            } else if request.httpMethod == "GET", url.path == "/api/sessions/approval-test" {
                data = try HapiJSON.encoder.encode(SessionResponse(session: session))
            } else {
                throw URLError(.unsupportedURL)
            }
            return (data, try XCTUnwrap(HTTPURLResponse(url: url, statusCode: responseStatus, httpVersion: nil, headerFields: nil)))
        }
    }

    private struct Card: View {
        let driver: Driver
        var body: some View {
            ToolCallBlockView(block: driver.block, basePath: "/workspace/hapi")
                .environment(\.chatInteractions, driver.interactor)
                .background(GeometryReader { geometry in
                    Color.clear
                        .onAppear { driver.height = geometry.size.height; driver.appearances += 1 }
                        .onChange(of: geometry.size.height) { _, height in driver.height = height }
                })
                .hapiReadingColumn()
        }
    }

    private struct Specimen: View {
        let driver: Driver
        var theme = HapiTheme.light
        var size = DynamicTypeSize.large
        var locale = Locale(identifier: "en")
        var body: some View {
            NavigationStack {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        UserTextBlockView(block: UserTextBlock(
                            id: "user", localId: nil, createdAt: 0, invokedAt: nil,
                            text: "请检查一下 iOS 界面的改动。", attachments: nil,
                            status: nil, originalText: nil, meta: nil
                        )).hapiReadingColumn()
                        Card(driver: driver)
                    }
                    .padding(.vertical, 16)
                }
                .background(theme.background)
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    ChatComposerView(interactor: driver.interactor)
                }
                .navigationTitle("HAPI · Approval")
                .navigationBarTitleDisplayMode(.inline)
            }
            .hapiTypography().hapiTheme(theme)
            .environment(\.dynamicTypeSize, size)
            .environment(\.locale, locale)
            .preferredColorScheme(theme.isDark ? .dark : .light)
        }
    }

    func testFlavorAndToolGatesRetainTheirExistingPermissionSemantics() {
        for (flavor, tool, deny, session, edits) in [
            ("claude", "Bash", PermissionAction.deny, true, false),
            ("claude", "Edit", .deny, false, true),
            ("claude", "ExitPlanMode", .deny, false, false),
            ("codex", "exec_command", .abort, true, false),
            ("codex", "Edit", .abort, true, false),
            ("cursor", "CursorBash", .abort, true, false),
            ("gemini", "GeminiBash", .abort, true, false),
        ] {
            let options = PermissionActionOptions(flavor: flavor, toolName: tool)
            XCTAssertEqual(options.denyAction, deny, "\(flavor), \(tool)")
            XCTAssertEqual(options.canAllowForSession, session)
            XCTAssertEqual(options.canAllowAllEdits, edits)
            XCTAssertEqual(options.hasMore, session || edits)
        }
        XCTAssertEqual(PermissionActionOptions(flavor: nil, toolName: "CodexPermission").denyAction, .abort)
        for tool in PermissionGates.editTools {
            XCTAssertTrue(PermissionActionOptions(flavor: "claude", toolName: tool).canAllowAllEdits)
        }
    }

    func testApprovalActionsHave44PointOuterTargetsAndNeverShiftWhenDisabled() {
        for theme in [HapiTheme.light, .dark, .oled] {
            for locale in ["en", "zh-Hans"] {
                for tool in ["Bash", "Edit", "ExitPlanMode"] {
                    let options = PermissionActionOptions(flavor: "claude", toolName: tool)
                    let ready = PermissionActionsRow(options: options, requestId: "approval", resolving: false) { _ in }
                        .hapiTheme(theme).environment(\.locale, Locale(identifier: locale))
                    let busy = PermissionActionsRow(options: options, requestId: "approval", resolving: true) { _ in }
                        .hapiTheme(theme).environment(\.locale, Locale(identifier: locale))
                    for width: CGFloat in [288, 358, 720] {
                        let measured = measure(ready, width: width)
                        XCTAssertEqual(measured.height, 44, accuracy: 1, "The entire button, not just its label, is 44 pt")
                        XCTAssertLessThanOrEqual(measured.width, width)
                        XCTAssertEqual(measure(busy, width: width).height, measured.height, accuracy: 1)
                    }
                    for (width, size) in [(CGFloat(120), DynamicTypeSize.large), (288, .accessibility5)] {
                        let measured = measure(ready, width: width, size: size)
                        if options.hasMore || size.isAccessibilitySize { XCTAssertGreaterThan(measured.height, 44) }
                        if size.isAccessibilitySize {
                            XCTAssertGreaterThanOrEqual(measured.height, options.hasMore ? 3 * 44 + 16 : 2 * 44 + 8)
                        }
                        XCTAssertLessThanOrEqual(measured.width, width)
                        XCTAssertEqual(measure(busy, width: width, size: size).height, measured.height, accuracy: 1)
                    }
                }
            }
        }
    }

    func testSubmittingPreservesGeometryAndSendsOnlyOneDecisionUntilSSESettles() async throws {
        let driver = try await Driver(flavor: "codex", toolName: "CodexBash")
        let (window, _) = try host(Specimen(driver: driver))
        defer { window.isHidden = true }
        try await eventually { driver.height > 100 }
        let initial = driver.height
        await driver.http.hold()
        defer { Task { await driver.http.release() } }
        driver.interactor.resolvePermission(requestId: "approval", action: .abort)
        driver.interactor.resolvePermission(requestId: "approval", action: .allow)
        try await eventually { await driver.http.posts.count == 1 }
        try await layoutSettles()
        XCTAssertEqual(driver.height, initial, accuracy: 1)
        XCTAssertEqual(driver.interactor.permissionOverrides["approval"], .resolving)
        let posts = await driver.http.posts
        let post = try XCTUnwrap(posts.first)
        XCTAssertTrue(post.path.hasSuffix("/approval/deny"))
        XCTAssertEqual(post.body, #"{"decision":"abort"}"#)
        try capture(window, name: "submitting")
        await driver.http.release()
        try await layoutSettles()
        XCTAssertEqual(driver.interactor.permissionOverrides["approval"], .resolving, "HTTP success alone is not a verdict")
        driver.settlePermission(.denied)
        try await eventually { driver.height < initial - 44 }
        XCTAssertNil(driver.interactor.permissionOverrides["approval"])
        try capture(window, name: "denied")
    }

    func testAlreadyHandledResponsesRemoveTheActionArea() async throws {
        for status in [404, 409] {
            let driver = try await Driver()
            let (window, _) = try host(Specimen(driver: driver))
            defer { window.isHidden = true }
            try await eventually { driver.height > 100 }
            let initial = driver.height
            await driver.http.setStatus(status)
            driver.interactor.resolvePermission(requestId: "approval", action: .allow)
            try await eventually { driver.interactor.permissionOverrides["approval"] == .alreadyHandled && driver.height < initial - 40 }
            try capture(window, name: "handled-\(status)")
        }
    }

    func testFailureRestoresActionsAndSessionApprovalKeepsItsExistingWireBody() async throws {
        let driver = try await Driver()
        let (window, _) = try host(Specimen(driver: driver))
        defer { window.isHidden = true }
        try await eventually { driver.height > 100 }
        let initial = driver.height
        await driver.http.setStatus(500)
        driver.interactor.resolvePermission(requestId: "approval", action: .allow)
        try await eventually { driver.notice != nil }
        XCTAssertNil(driver.interactor.permissionOverrides["approval"])
        try await layoutSettles()
        XCTAssertEqual(driver.height, initial, accuracy: 1)
        await driver.http.setStatus(200)
        driver.interactor.resolvePermission(requestId: "approval", action: .allowForSession)
        try await eventually { await driver.http.posts.count == 2 }
        let posts = await driver.http.posts
        let post = try XCTUnwrap(posts.last)
        XCTAssertEqual(post.body, #"{"allowTools":["Bash(git diff -- ios/Hapi)"]}"#)
        driver.settlePermission(.approved)
        try await eventually { driver.height < initial - 44 }
    }

    private struct Row: Identifiable, Equatable {
        let index: Int
        var id: String { String(index) }
    }

    private struct Transcript: View {
        let driver: Driver
        var body: some View {
            AnchoredTranscriptList(
                items: (0..<40).map { Row(index: $0) }, historyVersion: 0, jumpToken: 0,
                historyControlID: "-1", onViewport: { _ in }, onLayout: { _, _ in }
            ) { row in
                AnyView(Group {
                    if row.index == 10 { Card(driver: driver) }
                    else { Text("Message \(row.id)").frame(maxWidth: .infinity).frame(height: 100) }
                })
            }
            .hapiTypography()
        }
    }

    func testRecyclingRetainsSubmissionAndSettlementPreservesTheReadingAnchor() async throws {
        let driver = try await Driver()
        let (window, host) = try host(Transcript(driver: driver))
        defer { window.isHidden = true }
        func find(_ view: UIView) -> UICollectionView? {
            (view as? UICollectionView) ?? view.subviews.lazy.compactMap(find).first
        }
        let list = try XCTUnwrap(find(host.view))
        try await eventually { list.numberOfItems(inSection: 0) == 40 }
        func browse(_ index: Int) async throws {
            list.delegate?.scrollViewWillBeginDragging?(list)
            list.scrollToItem(at: IndexPath(item: index, section: 0), at: .top, animated: false)
            try await eventually { list.cellForItem(at: IndexPath(item: index, section: 0)) != nil }
            try await layoutSettles()
        }
        try await browse(10)
        let height = driver.height
        let appearances = driver.appearances
        await driver.http.hold()
        defer { Task { await driver.http.release() } }
        driver.interactor.resolvePermission(requestId: "approval", action: .allow)
        try await eventually { await driver.http.posts.count == 1 }
        try await browse(32)
        try await browse(10)
        XCTAssertGreaterThan(driver.appearances, appearances)
        XCTAssertEqual(driver.interactor.permissionOverrides["approval"], .resolving)
        XCTAssertEqual(driver.height, height, accuracy: 1)
        let cell = try XCTUnwrap(list.cellForItem(at: IndexPath(item: 10, section: 0)))
        let offset = cell.frame.minY - list.contentOffset.y
        await driver.http.release()
        driver.settlePermission(.approved)
        try await eventually { driver.height < height - 44 }
        try await layoutSettles()
        XCTAssertEqual(cell.frame.minY - list.contentOffset.y, offset, accuracy: 1)
    }

    func testProcessAndReadOnlyApprovalsUseCompactStatusPresentation() async throws {
        let driver = try await Driver()
        let summary = toolSummaryPresentation(driver.tool, basePath: nil)
        let approvalHeader = ToolSummaryRow(presentation: summary, state: .pending, showsStatus: false) {}
        let genericHeader = ToolSummaryRow(presentation: summary, state: .pending) {}
        XCTAssertLessThan(measure(approvalHeader, width: 320, size: .accessibility3).height,
                          measure(genericHeader, width: 320, size: .accessibility3).height)
        let process = PendingPermissionFooter(tool: driver.tool, requestId: "approval", interactions: driver.interactor)
        XCTAssertEqual(measure(process, width: 320).height, 44 + 8 + 44 + 24, accuracy: 1)
        let readonly = PermissionStateRow(permission: try XCTUnwrap(driver.tool.permission))
        XCTAssertLessThan(measure(readonly, width: 320).height, 44)
        let pendingHeader = measure(ToolDetailHeader(block: driver.block, basePath: nil), width: 320).height
        for state in [ToolCallState.running, .error] {
            var block = driver.block
            block.tool.state = state
            XCTAssertGreaterThan(measure(ToolDetailHeader(block: block, basePath: nil), width: 320).height,
                                 pendingHeader + 16, "Only the duplicate pending marker is hidden, not running/errors")
        }
        for status in [ToolPermissionStatus.approved, .denied, .resolved, .canceled] {
            let verdict = PermissionStateRow(permission: ToolPermission(id: "approval", status: status))
            XCTAssertLessThan(measure(verdict, width: 320).height, 44)
            XCTAssertLessThanOrEqual(measure(verdict, width: 288, size: .accessibility5).width, 288)
        }
    }

    func testQueuedActionsFitSmallColumnsLargeTypeAndDisabledRows() async throws {
        let driver = try await Driver()
        func row(enabled: Bool = true, uncertain: Bool = false, scheduled: Bool = false) -> QueuedRowView {
            QueuedRowView(row: QueuedMessageRow(
                id: "queued", localId: "local", text: "Update", attachmentNames: [],
                scheduledAt: scheduled ? 1_800_000_000_000 : nil,
                canAct: enabled, canSteer: !uncertain && !scheduled, indeterminate: uncertain
            ), interactor: driver.interactor)
        }
        for theme in [HapiTheme.light, .dark, .oled] {
            XCTAssertEqual(measure(row().hapiTheme(theme), width: 358).height, 56, accuracy: 1)
            for (width, size) in [(CGFloat(180), DynamicTypeSize.large), (288, .accessibility5), (720, .xxxLarge)] {
                let enabled = measure(row().hapiTheme(theme), width: width, size: size)
                XCTAssertLessThanOrEqual(enabled.width, width)
                if width < 320 { XCTAssertGreaterThan(enabled.height, 56) }
                XCTAssertEqual(measure(row(enabled: false).hapiTheme(theme), width: width, size: size).height,
                               enabled.height, accuracy: 1)
                for specimen in [row(uncertain: true), row(scheduled: true)] {
                    XCTAssertLessThanOrEqual(measure(specimen.hapiTheme(theme), width: width, size: size).width, width)
                }
            }
        }
        for (name, theme, size) in [("queue", HapiTheme.light, DynamicTypeSize.large),
                                    ("queue-large-type", .dark, .accessibility3)] {
            let view = ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    row()
                    row(uncertain: true)
                    row(scheduled: true)
                }
                .hapiReadingColumn().padding(.vertical, 24)
            }
            .background(theme.background)
            .hapiTypography().hapiTheme(theme)
            .environment(\.dynamicTypeSize, size)
            .preferredColorScheme(theme.isDark ? .dark : .light)
            let (window, _) = try host(view, width: 320)
            defer { window.isHidden = true }
            try await layoutSettles()
            try capture(window, name: name)
        }
    }

    func testApprovalSpecimensInThemesLocalesAndAccessibleSizes() async throws {
        let cases: [(String, HapiTheme, DynamicTypeSize, CGFloat, String)] = [
            ("light", .light, .large, 390, "en"), ("dark", .dark, .large, 390, "en"),
            ("oled", .oled, .large, 390, "en"), ("small", .light, .large, 320, "en"),
            ("chinese", .light, .large, 390, "zh-Hans"),
            ("large-type", .dark, .accessibility3, 390, "en"),
            ("largest-type", .light, .accessibility5, 390, "zh-Hans"),
            ("ipad", .light, .large, 1024, "en"),
        ]
        for (name, theme, size, width, locale) in cases {
            let driver = try await Driver()
            let (window, host) = try host(Specimen(driver: driver, theme: theme, size: size,
                                                 locale: Locale(identifier: locale)), width: width)
            defer { window.isHidden = true }
            try await eventually { driver.height > 100 }
            try await layoutSettles()
            if size == .large { XCTAssertLessThan(driver.height, 200, "A short approval should remain compact") }
            XCTAssertNil(host.presentedViewController, "Approvals stay inline")
            try capture(window, name: name)
            if size.isAccessibilitySize, let scroll = findScroll(host.view) {
                scroll.setContentOffset(CGPoint(x: 0, y: max(-scroll.adjustedContentInset.top,
                    scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom)), animated: false)
                try await layoutSettles()
                try capture(window, name: name + "-bottom")
            }
        }
    }

    private func measure<V: View>(_ view: V, width: CGFloat, size: DynamicTypeSize = .large) -> CGSize {
        UIHostingController(rootView: view.hapiTypography().environment(\.dynamicTypeSize, size))
            .sizeThatFits(in: CGSize(width: width, height: .greatestFiniteMagnitude))
    }

    private func host<V: View>(_ view: V, width: CGFloat = 390) throws -> (UIWindow, UIHostingController<V>) {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: width, height: 844)
        let host = UIHostingController(rootView: view)
        window.rootViewController = host
        window.makeKeyAndVisible()
        host.view.layoutIfNeeded()
        return (window, host)
    }

    private func findScroll(_ view: UIView) -> UIScrollView? {
        (view as? UIScrollView) ?? view.subviews.lazy.compactMap(findScroll).first
    }

    private func eventually(_ condition: () async -> Bool) async throws {
        for _ in 0..<150 {
            if await condition() { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTFail("Approval presentation did not settle")
    }

    private func layoutSettles() async throws {
        try await Task.sleep(for: .milliseconds(200))
    }

    private func capture(_ window: UIWindow, name: String) throws {
        guard let path = ProcessInfo.processInfo.environment["HAPI_APPROVAL_CAPTURE"] else { return }
        let directory = URL(fileURLWithPath: path, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        try XCTUnwrap(image.pngData()).write(to: directory.appendingPathComponent("approval-\(name).png"))
    }
}
