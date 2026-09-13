import Foundation
import HapiClient
import HapiProtocol
import XCTest
@testable import Hapi

@MainActor
final class ChatHistoryPumpTests: XCTestCase {
    func testInvalidatedOlderResponseRestartsDemandAfterTailSyncFinished() async throws {
        let performer = HistoryPumpHTTP()
        defer { Task { await performer.releaseOlder() } }
        // All REST calls use the fake; the unused SSE pipe targets a closed
        // loopback port, never a user's hub. Unique cache/draft namespace.
        let hubURL = "http://127.0.0.1:1/history-pump-\(UUID().uuidString)"
        let credentials = InMemoryCredentialStore()
        let payload = Data(#"{"uid":1,"exp":4102444800,"ns":"test"}"#.utf8).base64EncodedString()
        try credentials.store(HubCredentials(
            hubUrl: "http://127.0.0.1:1", accessToken: "test", jwt: "e30.\(payload).test"
        ))
        let hub = try XCTUnwrap(HubSession(hubUrl: hubURL, credentialStore: credentials, performer: performer))
        let model = ChatModel(session: hub, sessionId: "history")
        defer { model.stop(); hub.shutdown() }
        model.start()
        try await eventually { model.hasMore && !model.isSyncingTail && !model.blocks.isEmpty }
        let controller = await hub.windows.open(sessionId: "history")
        // Drain both ChatSession's entry sync and the interactor's reconcile.
        await controller.syncTail(ensureAfterCurrent: true)
        try await eventually { !model.isSyncingTail }
        model.readingViewportChanged(followsTail: false, needsOlder: true)
        try await eventually { await performer.beforeRequests == 1 }
        XCTAssertEqual(model.historyPaging.phase, .loading)

        // Invalidate the slow before request, finish sync, and let its state
        // reach the real ChatModel pipeline while olderTask still blocks it.
        await performer.enableTailUpdate()
        await controller.syncTail(ensureAfterCurrent: true)
        let revision = await controller.state.tailRevision
        try await eventually { model.tailRevision == revision && !model.isSyncingTail }
        try await Task.sleep(for: .milliseconds(30))
        XCTAssertEqual(model.historyPaging.phase, .loading)
        await performer.releaseOlder()

        // No new viewport, layout acknowledgement, or SSE event.
        try await eventually { await performer.beforeRequests == 2 }
        try await eventually { model.historyVersion == 1 }
        let state = await controller.state
        XCTAssertEqual(state.messages.map(\.id), ["fresh", "new", "live"])
        XCTAssertEqual(model.historyPaging.phase, .awaitingLayout(1))
    }

    func testInspectorSurfaceKeepsLivePipelineAcrossNavigationHandoff() async throws {
        let performer = HistoryPumpHTTP()
        let url = "http://127.0.0.1:1/tool-inspector-\(UUID().uuidString)"
        let credentials = InMemoryCredentialStore()
        let payload = Data(#"{"uid":1,"exp":4102444800,"ns":"test"}"#.utf8).base64EncodedString()
        try credentials.store(HubCredentials(hubUrl: "http://127.0.0.1:1", accessToken: "test", jwt: "e30.\(payload).test"))
        let hub = try XCTUnwrap(HubSession(hubUrl: url, credentialStore: credentials, performer: performer))
        let model = ChatModel(session: hub, sessionId: "inspection")
        defer { model.stop(); hub.shutdown() }
        model.retainSurface("chat")
        try await eventually { !model.blocks.isEmpty && !model.isSyncingTail }
        let controller = await hub.windows.open(sessionId: "inspection")
        await controller.syncTail(ensureAfterCurrent: true)
        let initialRevision = await controller.state.tailRevision
        model.beginContentInspection()
        model.retainSurface("inspector:chat")
        model.retainSurface("inspector:chat") // Idempotent appearance.
        model.releaseSurface("chat")
        try await Task.sleep(for: .milliseconds(30))
        XCTAssertEqual(model.visibleSurfaces, ["inspector:chat"])
        await performer.enableTailUpdate()
        await controller.syncTail(ensureAfterCurrent: true)
        try await eventually { model.tailRevision > initialRevision }
        XCTAssertFalse(model.followsTail)
        model.retainSurface("process:task")
        model.releaseSurface("inspector:chat")
        XCTAssertEqual(model.visibleSurfaces, ["process:task"])
        model.retainSurface("chat")
        model.releaseSurface("process:task")
        XCTAssertEqual(model.visibleSurfaces, ["chat"])
        // Reading a full user log follows the same navigation lease and
        // must suppress hidden paging/tail-follow reports until dismissal.
        model.beginContentInspection()
        model.retainSurface("message:chat")
        XCTAssertTrue(model.isInspectingContent)
        model.readingViewportChanged(followsTail: true, needsOlder: true)
        XCTAssertFalse(model.followsTail)
        try await Task.sleep(for: .milliseconds(30))
        let olderRequests = await performer.beforeRequests
        XCTAssertEqual(olderRequests, 0)
        model.releaseSurface("message:chat")
        XCTAssertFalse(model.isInspectingContent)
        XCTAssertFalse(model.followsTail, "Closing the reader must not silently return to latest")
        model.releaseSurface("chat")
    }

    private func eventually(file: StaticString = #filePath, line: UInt = #line, _ condition: () async -> Bool) async throws {
        for _ in 0..<200 {
            if await condition() { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTFail("History coordinator did not reach the expected state", file: file, line: line)
        throw URLError(.timedOut)
    }
}

private actor HistoryPumpHTTP: HTTPPerforming {
    private(set) var beforeRequests = 0
    private var olderContinuation: CheckedContinuation<Void, Never>?
    private var sendsTailUpdate = false

    func enableTailUpdate() { sendsTailUpdate = true }

    func releaseOlder() {
        olderContinuation?.resume()
        olderContinuation = nil
    }

    func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let url = request.url!
        guard url.lastPathComponent == "messages" else {
            return (Data(#"{"error":"unused test endpoint"}"#.utf8),
                    HTTPURLResponse(url: url, statusCode: 404, httpVersion: nil, headerFields: nil)!)
        }
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let response: MessagesResponse
        if query.contains(where: { $0.name == "beforeAt" }) {
            beforeRequests += 1
            let stale = beforeRequests == 1
            if stale {
                await withCheckedContinuation { olderContinuation = $0 }
            }
            response = page(
                [row(stale ? "stale" : "fresh", seq: stale ? 9 : 8)],
                direction: .before, hasMore: false
            )
        } else if query.contains(where: { $0.name == "afterAt" }) {
            response = page(sendsTailUpdate ? [row("live", seq: 11)] : [], direction: .after, hasMore: false)
        } else {
            response = page([row("new", seq: 10)], direction: .latest, hasMore: true)
        }
        return (try JSONEncoder().encode(response),
                HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }

    private func row(_ id: String, seq: Int) -> DecryptedMessage {
        DecryptedMessage(
            id: id, seq: seq,
            content: [
                "role": "agent",
                "content": ["type": "codex", "data": ["type": "message", "message": .string(id)]],
            ],
            createdAt: seq * 1000, invokedAt: seq * 1000
        )
    }

    private func page(
        _ messages: [DecryptedMessage], direction: MessagesPage.Direction, hasMore: Bool
    ) -> MessagesResponse {
        MessagesResponse(messages: messages, page: MessagesPage(
            direction: direction, limit: 200, epoch: 1, reset: false,
            nextBeforeSeq: direction == .after ? nil : messages.first?.seq,
            nextBeforeAt: direction == .after ? nil : messages.first?.createdAt,
            nextAfterSeq: direction == .after ? (messages.last?.seq ?? 10) : nil,
            nextAfterAt: direction == .after ? (messages.last?.createdAt ?? 10000) : nil,
            snapshotHeadSeq: messages.last?.seq ?? 10,
            snapshotHeadAt: messages.last?.createdAt ?? 10000,
            hasMore: hasMore
        ))
    }
}
