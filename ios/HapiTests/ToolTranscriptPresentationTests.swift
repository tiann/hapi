import HapiClient
@testable import HapiUI
import SwiftUI
import UIKit
import XCTest
@testable import Hapi
@testable import HapiProtocol

/// Render the real ChatModel → ChatTranscriptView → recycled UIKit rows, not a
/// standalone ToolGroupBlockView specimen. HTTP is faked; SSE targets closed loopback.
@MainActor
final class ToolTranscriptPresentationTests: XCTestCase {
    private struct Harness: View {
        let model: ChatModel
        let session: HubSession
        let theme: HapiTheme
        let size: DynamicTypeSize

        var body: some View {
            NavigationStack {
                ChatTranscriptView(model: model)
                    .safeAreaInset(edge: .bottom, spacing: 0) {
                        ChatComposerView(interactor: model.interactor)
                    }
                    .navigationTitle("HAPI · UI specimen")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolPresentations(model: model, session: session, owner: "chat", openFile: { _ in })
            }
            .hapiTypography()
            .hapiTheme(theme)
            .environment(\.dynamicTypeSize, size)
            .environment(\.colorScheme, theme.isDark ? .dark : .light)
            .environment(\.hapiMarkdownCache, model.markdownCache)
            .preferredColorScheme(theme.isDark ? .dark : .light)
        }
    }

    func testGroupBrowserNeverExpandsTranscriptAndDismissalPreservesAnchor() async throws {
        let credentials = InMemoryCredentialStore()
        let payload = Data(#"{"uid":1,"exp":4102444800,"ns":"test"}"#.utf8).base64EncodedString()
        try credentials.store(HubCredentials(hubUrl: "http://127.0.0.1:1", accessToken: "test", jwt: "e30.\(payload).test"))
        let hub = try XCTUnwrap(HubSession(hubUrl: "http://127.0.0.1:1/tool-transcript-\(UUID().uuidString)",
                                         credentialStore: credentials, performer: ToolTranscriptHTTP()))
        let model = ChatModel(session: hub, sessionId: "tool-transcript")
        defer { model.stop(); hub.shutdown() }
        model.start()
        try await eventually { !model.blocks.isEmpty && !model.isSyncingTail }
        let groups = model.blocks.compactMap { block -> ToolGroupBlock? in
            guard case .toolGroup(let group) = block else { return nil }
            return group
        }
        XCTAssertEqual(groups.map(\.tools.count), [42, 5])
        let first = try XCTUnwrap(groups.first)
        let last = try XCTUnwrap(groups.last)
        XCTAssertEqual(ToolGroupPresentation(first).title, "42 tool calls")
        XCTAssertEqual(ToolGroupPresentation(last).title, "5 tool calls")
        let controller = await hub.windows.open(sessionId: "tool-transcript")

        let cases: [(String, HapiTheme, DynamicTypeSize, CGFloat)] = [
            ("light-transcript", .light, .large, 390),
            ("dark-transcript", .dark, .large, 390),
            ("small-transcript", .light, .large, 320),
            ("ax-transcript", .light, .accessibility3, 390),
        ]
        for (name, theme, size, width) in cases {
            let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
            let window = UIWindow(windowScene: scene)
            window.frame = CGRect(x: 0, y: 0, width: width, height: 844)
            let host = UIHostingController(rootView: Harness(model: model, session: hub, theme: theme, size: size))
            window.rootViewController = host
            window.makeKeyAndVisible()
            defer { window.isHidden = true }
            host.view.layoutIfNeeded()
            let collection = try XCTUnwrap(findCollection(host.view))
            try await eventually { collection.numberOfItems(inSection: 0) == 6 }
            try await Task.sleep(for: .milliseconds(250))
            for index in [2, 4] {
                let summary = try XCTUnwrap(collection.layoutAttributesForItem(at: IndexPath(item: index, section: 0)))
                XCTAssertGreaterThanOrEqual(summary.frame.height, 44)
                if size == .large { XCTAssertLessThanOrEqual(summary.frame.height, 100) }
            }
            try capture(window, name: name)
            let cell = try XCTUnwrap(collection.visibleCells
                .filter { $0.accessibilityIdentifier != "chat-row-chat-history-control" }
                .sorted { $0.frame.minY < $1.frame.minY }.first)
            let anchorID = cell.accessibilityIdentifier
            let anchorY = cell.frame.minY - collection.contentOffset.y
            XCTAssertTrue(model.inspectToolGroup(first.id, owner: "chat"))
            try await eventually { host.presentedViewController != nil && !model.followsTail }
            try await Task.sleep(for: .milliseconds(600))
            XCTAssertTrue(model.isInspectingContent)
            XCTAssertNil(model.toolInspection.selection, "Group root must pause following without a selected tool")
            XCTAssertEqual(collection.numberOfItems(inSection: 0), 6)
            let presented = try XCTUnwrap(host.presentedViewController)
            let transcript = try XCTUnwrap(findTranscriptController(host))
            #if DEBUG
            let configurations = transcript.cellConfigurationCount
            #endif
            let tool = try XCTUnwrap(first.tools.last)
            for update in 0..<3 {
                let seq = (await controller.state.newestSeq ?? 0) + 1
                let result = "\(name) streamed result \(update)"
                let message = DecryptedMessage(id: "live-\(seq)", seq: seq,
                    content: ["role": "agent", "content": ["type": "codex", "data": [
                        "type": "tool-call-result", "callId": .string(tool.tool.id),
                        "output": .string(result), "is_error": false,
                    ]]], createdAt: seq * 1000, invokedAt: seq * 1000)
                await controller.onMessageEvent(.messageReceived(namespace: nil, sessionId: "tool-transcript", message: message))
                try await eventually { model.toolInspection.tools[tool.id]?.tool.result == .string(result) }
                XCTAssertTrue(host.presentedViewController === presented)
                XCTAssertEqual(collection.numberOfItems(inSection: 0), 6)
            }
            #if DEBUG
            XCTAssertEqual(transcript.cellConfigurationCount, configurations,
                           "Member output must not reconfigure unchanged transcript summaries")
            #endif
            if size.isAccessibilitySize {
                let browser = try XCTUnwrap(findCollection(presented.view))
                let lastRow = try XCTUnwrap(browser.layoutAttributesForItem(at: IndexPath(item: 41, section: 0)))
                XCTAssertGreaterThan(lastRow.frame.height, 60, "The sheet must inherit the conversation's Dynamic Type")
            }
            try capture(window, name: "\(name)-browser")
            model.toolInspection.dismiss(owner: "chat")
            try await eventually { host.presentedViewController == nil && !model.isInspectingContent }
            let restored = try XCTUnwrap(collection.visibleCells.first { $0.accessibilityIdentifier == anchorID })
            XCTAssertEqual(restored.frame.minY - collection.contentOffset.y, anchorY, accuracy: 1)
            XCTAssertFalse(model.followsTail)
            XCTAssertEqual(collection.numberOfItems(inSection: 0), 6)
        }
    }

    func testPlanPublicationUpdatesRecyclingAndInspectorPreserveTheDocumentAndAnchor() async throws {
        let plan = "# Initial proposal\n\nRead the document without opening the inspector."
        let credentials = InMemoryCredentialStore()
        let payload = Data(#"{"uid":1,"exp":4102444800,"ns":"test"}"#.utf8).base64EncodedString()
        try credentials.store(HubCredentials(hubUrl: "http://127.0.0.1:1", accessToken: "test", jwt: "e30.\(payload).test"))
        let hub = try XCTUnwrap(HubSession(hubUrl: "http://127.0.0.1:1/plan-transcript-\(UUID().uuidString)",
                                         credentialStore: credentials, performer: ToolTranscriptHTTP(proposedPlan: plan)))
        let model = ChatModel(session: hub, sessionId: "tool-transcript")
        defer { model.stop(); hub.shutdown() }
        model.start()
        try await eventually { !model.blocks.isEmpty && !model.isSyncingTail }
        XCTAssertNotNil(model.markdownCache.cached(plan), "Prewarm plan Markdown before publishing rows")
        let index = try XCTUnwrap(model.blocks.firstIndex { $0.stableId == "proposal" }) + 1
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        let host = UIHostingController(rootView: Harness(model: model, session: hub, theme: .light, size: .large))
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        host.view.layoutIfNeeded()
        try await eventually { findCollection(host.view) != nil }
        let collection = try XCTUnwrap(findCollection(host.view))
        try await eventually { collection.numberOfItems(inSection: 0) == model.blocks.count + 1 }
        collection.delegate?.scrollViewWillBeginDragging?(collection)
        collection.scrollToItem(at: IndexPath(item: index, section: 0), at: .top, animated: false)
        try await eventually { collection.cellForItem(at: IndexPath(item: index, section: 0)) != nil }
        try await Task.sleep(for: .milliseconds(200))
        let cell = try XCTUnwrap(collection.cellForItem(at: IndexPath(item: index, section: 0)))
        let initialHeight = cell.frame.height
        XCTAssertGreaterThan(initialHeight, 100, "A plan must not remain a summary row")
        let anchorY = cell.frame.minY - collection.contentOffset.y
        let updated = "# Revised proposal\n\n" + String(repeating: "More plan detail. ", count: 150)
        let controller = await hub.windows.open(sessionId: "tool-transcript")
        let seq = (await controller.state.newestSeq ?? 0) + 1
        let message = DecryptedMessage(id: "plan-update", seq: seq,
            content: ["role": "agent", "content": ["type": "codex", "data": [
                "type": "tool-call", "callId": "proposal", "name": "ExitPlanMode",
                "input": ["plan": .string(updated)],
            ]]], createdAt: seq * 1000, invokedAt: seq * 1000)
        await controller.onMessageEvent(.messageReceived(namespace: nil, sessionId: "tool-transcript", message: message))
        try await eventually { model.toolInspection.tools["proposal"]?.tool.input?[chatKey: "plan"]?.chatString == updated }
        XCTAssertNotNil(model.markdownCache.cached(updated))
        try await eventually { (collection.cellForItem(at: IndexPath(item: index, section: 0))?.frame.height ?? 0) > initialHeight + 100 }
        XCTAssertEqual(cell.frame.minY - collection.contentOffset.y, anchorY, accuracy: 1)
        let count = collection.numberOfItems(inSection: 0)
        collection.scrollToItem(at: IndexPath(item: count - 1, section: 0), at: .bottom, animated: false)
        try await Task.sleep(for: .milliseconds(150))
        XCTAssertNil(collection.cellForItem(at: IndexPath(item: index, section: 0)))
        collection.delegate?.scrollViewWillBeginDragging?(collection)
        collection.scrollToItem(at: IndexPath(item: index, section: 0), at: .top, animated: false)
        try await Task.sleep(for: .milliseconds(200))
        let returned = try XCTUnwrap(collection.cellForItem(at: IndexPath(item: index, section: 0)))
        XCTAssertGreaterThan(returned.frame.height, initialHeight + 100)
        let restoredY = returned.frame.minY - collection.contentOffset.y
        model.beginContentInspection()
        model.retainSurface("inspector:chat")
        model.toolInspection.open(try XCTUnwrap(model.toolInspection.tools["proposal"]), owner: "chat")
        try await eventually { host.presentedViewController != nil }
        XCTAssertEqual(planProposalMarkdown(try XCTUnwrap(model.toolInspection.selection).block.tool), updated)
        model.toolInspection.dismiss(owner: "chat")
        try await eventually { host.presentedViewController == nil && !model.isInspectingContent }
        XCTAssertEqual(returned.frame.minY - collection.contentOffset.y, restoredY, accuracy: 1)
        XCTAssertEqual(collection.numberOfItems(inSection: 0), count)
        XCTAssertFalse(model.followsTail)
    }

    private func eventually(_ condition: () -> Bool) async throws {
        for _ in 0..<150 {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTFail("Transcript did not settle")
    }

    private func findCollection(_ view: UIView) -> UICollectionView? {
        if let collection = view as? UICollectionView { return collection }
        return view.subviews.lazy.compactMap(findCollection).first
    }

    private func findTranscriptController(_ controller: UIViewController) -> TranscriptCollectionController<TranscriptRow>? {
        if let transcript = controller as? TranscriptCollectionController<TranscriptRow> { return transcript }
        return controller.children.lazy.compactMap(findTranscriptController).first
    }

    private func capture(_ window: UIWindow, name: String) throws {
        guard let path = ProcessInfo.processInfo.environment["HAPI_TOOL_CAPTURE"] else { return }
        let directory = URL(fileURLWithPath: path, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let renderer = UIGraphicsImageRenderer(bounds: window.bounds)
        let image = renderer.image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
        try XCTUnwrap(image.pngData()).write(to: directory.appendingPathComponent("\(name).png"))
    }
}

private struct ToolTranscriptHTTP: HTTPPerforming {
    var proposedPlan: String? = nil

    func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let url = request.url!
        guard url.lastPathComponent == "messages" else {
            return (Data(#"{"error":"unused test endpoint"}"#.utf8),
                    HTTPURLResponse(url: url, statusCode: 404, httpVersion: nil, headerFields: nil)!)
        }
        let after = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.contains { $0.name == "afterAt" } == true
        let rows = messages()
        let response = MessagesResponse(messages: after ? [] : rows, page: MessagesPage(
            direction: after ? .after : .latest, limit: 200, epoch: 1, reset: false,
            nextBeforeSeq: after ? nil : rows.first?.seq, nextBeforeAt: after ? nil : rows.first?.createdAt,
            nextAfterSeq: after ? rows.last?.seq : nil, nextAfterAt: after ? rows.last?.createdAt : nil,
            snapshotHeadSeq: rows.last?.seq, snapshotHeadAt: rows.last?.createdAt, hasMore: false
        ))
        return (try JSONEncoder().encode(response), HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }

    private func messages() -> [DecryptedMessage] {
        var rows: [DecryptedMessage] = []
        func append(_ data: JSONValue) {
            let seq = rows.count + 1
            rows.append(DecryptedMessage(id: "row-\(seq)", seq: seq,
                content: ["role": "agent", "content": ["type": "codex", "data": data]],
                createdAt: seq * 1000, invokedAt: seq * 1000))
        }
        func tool(_ name: String, input: JSONValue, error: Bool = false) {
            let id = "tool-\(rows.count)"
            append(["type": "tool-call", "callId": .string(id), "name": .string(name), "input": input])
            append(["type": "tool-call-result", "callId": .string(id), "output": "Done", "is_error": .bool(error)])
        }
        append(["type": "message", "message": "工具详情独立阅读；关闭后保留聊天位置。"])
        for index in 0..<42 {
            // Exercise the shared Codex wire shape, not just legacy Bash calls:
            // unknown actions must remain grouped in the real transcript/inspector.
            if index < 17 {
                tool("CodexBash", input: [
                    "command": "git diff --stat", "command_source": "unifiedExecStartup",
                    "command_actions": [["type": "unknown", "command": "git diff --stat"]],
                ], error: index == 0)
            }
            else if index < 23 { tool("Edit", input: ["file_path": "/workspace/ChatView.swift"]) }
            else { tool("exec", input: ["code": "await tools.exec_command({cmd: 'swift test'})"]) }
        }
        append(["type": "message", "message": "实现与测试已完成。正在核对浅色／深色 UI，并清理测试生成文件。"])
        tool("view_image", input: ["path": "/tmp/hapi-tool-inspector-review-20260911-final/light-summary.png"])
        tool("view_image", input: ["path": "/tmp/hapi-tool-inspector-review-20260911-final/dark-detail.png"])
        tool("Bash", input: ["command": "rm ios/Packages/HapiKit/Package.resolved && git diff --check && git status --short"])
        tool("exec", input: ["code": "await tools.mcp__hapi__display_image({path: '/tmp/light-summary.png'})"])
        tool("mcp__hapi__display_image", input: ["path": "/tmp/light-summary.png"])
        if let proposedPlan {
            append(["type": "tool-call", "name": "ExitPlanMode", "callId": "proposal", "input": ["plan": .string(proposedPlan)]])
            append(["type": "tool-call-result", "callId": "proposal", "output": .null])
            for index in 0..<20 {
                append(["type": "message", "id": .string("after-plan-\(index)"), "message": .string("Later message \(index)\n\nKeeps the plan away from the live tail for recycling tests.")])
            }
        }
        append(["type": "message", "message": "检查完成，可以继续对话。"])
        return rows
    }
}
