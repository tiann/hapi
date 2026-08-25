import Foundation
import HapiClient
import HapiProtocol
import Testing

/// Pagination conformance suite: replays every op script in
/// `shared/fixtures/pagination/` against the REAL `MessageWindowController`
/// (driven by a scripted `MessagesProviding`) and requires
///
///  - the exact same `GET /messages` requests, in order (`expectedRequests`,
///    canonical-JSON compare incl. the explicit-null `untilAt`/`untilSeq` on
///    the first catch-up request),
///  - the same older-load outcomes (`expectedOutcome`) and queued-state
///    reconcile candidates (`expectedCandidates`),
///  - the exact final window projection (`expectedState`).
///
/// The twin of `web/src/lib/message-window-store.fixtures.test.ts` and the
/// Android `PaginationFixtureTest`. A failure here means this port drifted
/// from the web reference (or the fixtures were regenerated after a web
/// behavior change and the port must catch up). Failures are per-fixture,
/// labeled `ops[i]`, and canonical mismatches print a first-differing-line
/// diff with context.
///
/// Determinism: ops run strictly sequentially and every controller call is
/// awaited to completion (the scripted provider answers immediately), so the
/// replay is exact — mirroring the web harness awaiting every op.
@Suite("Pagination golden fixtures")
struct PaginationFixtureTests {
    /// Highest fixture document schema this suite understands. Mirrors the
    /// README rule: fail loudly when the on-disk version is newer.
    private static let supportedFixtureVersion = 1

    // MARK: - Fixture discovery (same #filePath scheme as ChatFixtureTests)

    /// Repo-root `shared/fixtures`, resolved from this file's own location:
    /// `ios/Packages/HapiKit/Tests/HapiClientTests/…` → package root →
    /// `../../../shared/fixtures`.
    private static func fixturesDirectory() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // Tests/HapiClientTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // package root: ios/Packages/HapiKit
            .appendingPathComponent("../../../shared/fixtures")
            .standardizedFileURL
    }

    /// Sorted fixture file names — the parameterized-test argument list.
    static let paginationFixtureNames: [String] = {
        let directory = fixturesDirectory().appendingPathComponent("pagination")
        let contents = (try? FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: nil
        )) ?? []
        return contents
            .filter { $0.pathExtension == "json" }
            .map { $0.lastPathComponent }
            .sorted()
    }()

    private static func fixtureURL(_ fileName: String) -> URL {
        fixturesDirectory().appendingPathComponent("pagination").appendingPathComponent(fileName)
    }

    @Test func hasPaginationFixturesOnDisk() {
        #expect(
            !Self.paginationFixtureNames.isEmpty,
            "no pagination fixtures found under \(Self.fixturesDirectory().path)"
        )
    }

    @Test func fixturesVersionIsSupported() throws {
        let versionFile = Self.fixturesDirectory().appendingPathComponent("VERSION")
        let text = try String(contentsOf: versionFile, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let version = try #require(Int(text), "VERSION must be a single integer, got: \(text)")
        #expect(
            version <= Self.supportedFixtureVersion,
            "fixtures were regenerated with a newer schema (\(version)); update the window port"
        )
    }

    // MARK: - Replay

    @Test("fixture", arguments: PaginationFixtureTests.paginationFixtureNames)
    func fixtureReplayMatchesStore(_ fileName: String) async throws {
        let data = try Data(contentsOf: Self.fixtureURL(fileName))
        let document = try JSONDecoder().decode(JSONValue.self, from: data)

        let fixtureVersion = try #require(document["fixtureVersion"]?.intValue, "\(fileName): fixtureVersion")
        #expect(fixtureVersion <= Self.supportedFixtureVersion,
                "\(fileName) uses fixtureVersion \(fixtureVersion)")
        let name = try #require(document["name"]?.stringValue, "\(fileName): name")
        #expect("\(name).json" == fileName, "\(fileName) name field mismatch")

        let scripted = ScriptedMessagesProvider()
        let controller = MessageWindowController(
            sessionId: "fixture-pagination-\(name)",
            provider: scripted
        )

        let ops = try #require(document["ops"]?.arrayValue, "\(fileName): ops")
        for (opIndex, opValue) in ops.enumerated() {
            try await executeOp(
                opValue,
                controller: controller,
                scripted: scripted,
                label: "\(fileName) ops[\(opIndex)]"
            )
        }

        let expectedState = try #require(document["expectedState"], "\(fileName): expectedState")
        let projected = Self.projectWindowState(await controller.state)
        compareCanonical(expected: expectedState, actual: projected, label: "\(fileName) expectedState")
    }

    // MARK: - Op replay

    private func executeOp(
        _ opValue: JSONValue,
        controller: MessageWindowController,
        scripted: ScriptedMessagesProvider,
        label: String
    ) async throws {
        let op = try #require(opValue.objectValue, "\(label): op must be an object")
        let kind = try #require(op["op"]?.stringValue, "\(label): missing op kind")

        switch kind {
        case "sync-tail":
            await scripted.begin(try decodeResponses(op, label: label))
            await controller.syncTail()
            await assertSettled(controller: controller, scripted: scripted, label: label)
            await assertRequests(op, scripted: scripted, label: label)

        case "fetch-older":
            await scripted.begin(try decodeResponses(op, label: label))
            let outcome = await controller.fetchOlder()
            await assertSettled(controller: controller, scripted: scripted, label: label)
            await assertRequests(op, scripted: scripted, label: label)
            if let expected = op["expectedOutcome"] {
                compareCanonical(
                    expected: expected,
                    actual: Self.projectOutcome(outcome, label: label),
                    label: "\(label) outcome"
                )
            }

        case "sse-messages":
            let rows = try #require(op["messages"]?.arrayValue, "\(label): messages")
            await controller.ingestSSEMessages(try rows.map { try decodeWindowMessage($0, label: label) })

        case "append-optimistic":
            let message = try #require(op["message"], "\(label): message")
            await controller.appendOptimistic(try decodeWindowMessage(message, label: label))

        case "update-status":
            let localId = try #require(op["localId"]?.stringValue, "\(label): localId")
            let statusWire = try #require(op["status"]?.stringValue, "\(label): status")
            let status = try #require(MessageStatus(rawValue: statusWire), "\(label): status '\(statusWire)'")
            await controller.updateStatus(localId: localId, status: status)

        case "messages-consumed":
            let localIds = try #require(op["localIds"]?.arrayValue, "\(label): localIds")
                .compactMap(\.stringValue)
            let invokedAt = try #require(op["invokedAt"]?.intValue, "\(label): invokedAt")
            await controller.markConsumed(localIds: localIds, invokedAt: invokedAt)

        case "message-cancelled":
            let localId = try #require(op["localId"]?.stringValue, "\(label): localId")
            await controller.removeMessage(localIdOrId: localId)

        case "cancel-invoked":
            let localId = try #require(op["localId"]?.stringValue, "\(label): localId")
            let message = try #require(op["message"], "\(label): message")
            await controller.applyCancelInvoked(
                localId: localId,
                message: try decodeWindowMessage(message, label: label)
            )

        case "set-view-mode":
            let mode = op["mode"]?.stringValue == "history" ? MessageViewMode.history : .tail
            await controller.setViewMode(mode)

        case "queued-state":
            // Mirrors the web runner (reconcileQueuedStateAfterConnect's post
            // tail-sync half): collect candidates, apply invoked verdicts
            // grouped by timestamp, drop deleted candidates.
            let candidates = await controller.queuedReconcileCandidateLocalIds()
            if let expected = op["expectedCandidates"] {
                compareCanonical(
                    expected: expected,
                    actual: .array(candidates.map(JSONValue.string)),
                    label: "\(label) candidates"
                )
            }
            let invokedEntries = try #require(op["invoked"]?.arrayValue, "\(label): invoked")
            var timestamps: [Int] = []
            var localIdsByTimestamp: [Int: [String]] = [:]
            for entry in invokedEntries {
                let invokedAt = try #require(entry["invokedAt"]?.intValue, "\(label): invoked.invokedAt")
                let localId = try #require(entry["localId"]?.stringValue, "\(label): invoked.localId")
                if localIdsByTimestamp[invokedAt] == nil { timestamps.append(invokedAt) }
                localIdsByTimestamp[invokedAt, default: []].append(localId)
            }
            for invokedAt in timestamps {
                await controller.markConsumed(
                    localIds: localIdsByTimestamp[invokedAt]!,
                    invokedAt: invokedAt
                )
            }
            let queuedLocalIds = try #require(op["queuedLocalIds"]?.arrayValue, "\(label): queuedLocalIds")
                .compactMap(\.stringValue)
            await controller.reconcileQueuedLocalIds(
                candidateLocalIds: candidates,
                queuedLocalIds: queuedLocalIds
            )

        default:
            Issue.record("\(label): unknown op '\(kind)'")
        }
    }

    // MARK: - Decoding

    private func decodeResponses(_ op: [String: JSONValue], label: String) throws -> [MessagesResponse] {
        let responses = try #require(op["responses"], "\(label): responses")
        return try Self.decodeValue([MessagesResponse].self, responses, label: "\(label) responses")
    }

    private func decodeWindowMessage(_ value: JSONValue, label: String) throws -> WindowMessage {
        try Self.decodeValue(WindowMessage.self, value, label: "\(label) message")
    }

    /// Typed decode of a JSONValue subtree (round-trip through canonical
    /// text — `WindowMessage`'s own Codable keeps the invokedAt tri-state).
    private static func decodeValue<T: Decodable>(
        _ type: T.Type,
        _ value: JSONValue,
        label: String
    ) throws -> T {
        do {
            return try JSONDecoder().decode(T.self, from: Data(toCanonicalJSON(value).utf8))
        } catch {
            Issue.record("\(label): decode failed — \(error)")
            throw error
        }
    }

    // MARK: - Assertions

    private func assertSettled(
        controller: MessageWindowController,
        scripted: ScriptedMessagesProvider,
        label: String
    ) async {
        let remaining = await scripted.remaining
        #expect(remaining == 0, "\(label): \(remaining) scripted response(s) left unconsumed")
        let state = await controller.state
        #expect(state.warning == nil, "\(label): store reported a warning: \(state.warning ?? "")")
        #expect(
            !state.isSyncingTail && !state.isLoadingMore,
            "\(label): store still busy after the op settled"
        )
    }

    private func assertRequests(
        _ op: [String: JSONValue],
        scripted: ScriptedMessagesProvider,
        label: String
    ) async {
        guard let expected = op["expectedRequests"] else { return }
        let actual = JSONValue.array(await scripted.requests)
        compareCanonical(expected: expected, actual: actual, label: "\(label) requests")
    }

    /// Byte-for-byte canonical comparison; on mismatch records the first
    /// differing line with context from both documents.
    private func compareCanonical(expected: JSONValue, actual: JSONValue, label: String) {
        let expectedText = toCanonicalJSON(expected)
        let actualText = toCanonicalJSON(actual)
        if expectedText != actualText {
            Issue.record(Comment(rawValue: Self.diff(
                expected: expectedText,
                actual: actualText,
                label: label
            )))
        }
    }

    // MARK: - Projection (normative, shared/fixtures/README.md "expectedState")

    private static func projectOutcome(_ outcome: OlderLoadOutcome, label: String) -> JSONValue {
        switch outcome {
        case .applied(_, let hasMore, let addedRenderableCount):
            return .object([
                "kind": .string("applied"),
                "hasMore": .bool(hasMore),
                "addedRenderableCount": .number(Double(addedRenderableCount)),
            ])
        case .stopped(let reason):
            return .object([
                "kind": .string("stopped"),
                "reason": .string(reason.rawValue),
            ])
        case .failed(let error):
            Issue.record("\(label): older-page load failed: \(error)")
            return .object(["kind": .string("failed")])
        }
    }

    private static func projectWindowState(_ state: MessageWindowState) -> JSONValue {
        .object([
            "messages": .array(state.messages.map(projectMessage)),
            "hasMore": .bool(state.hasMore),
            "epoch": state.epoch.map { JSONValue.number(Double($0)) } ?? .null,
            "viewMode": .string(state.viewMode.rawValue),
            "olderCursor": projectCursor(state.oldestPosition),
            "newestCursor": projectCursor(state.newestPosition),
        ])
    }

    private static func projectMessage(_ message: WindowMessage) -> JSONValue {
        var projected: [String: JSONValue] = [
            "id": .string(message.id),
            "localId": message.localId.map(JSONValue.string) ?? .null,
            "seq": message.seq.map { JSONValue.number(Double($0)) } ?? .null,
            "createdAt": .number(Double(message.createdAt)),
            "queued": .bool(message.isQueuedForInvocation),
            "optimistic": .bool(message.isOptimistic),
        ]
        // Wire tri-state: the key appears only when the wire carried it.
        switch message.invokedAt {
        case .absent:
            break
        case .null:
            projected["invokedAt"] = .null
        case .number(let value):
            projected["invokedAt"] = .number(Double(value))
        }
        if let scheduledAt = message.scheduledAt {
            projected["scheduledAt"] = .number(Double(scheduledAt))
        }
        if let status = message.status {
            projected["status"] = .string(status.rawValue)
        }
        return .object(projected)
    }

    private static func projectCursor(_ position: MessagePosition?) -> JSONValue {
        guard let position else { return .null }
        return .object([
            "at": .number(Double(position.at)),
            "seq": .number(Double(position.seq)),
        ])
    }

    // MARK: - Diff (same shape as ChatFixtureTests)

    /// Readable line-level diff: the first differing line with surrounding
    /// context from both documents, so the CI log pinpoints the divergence
    /// without downloading artifacts.
    private static func diff(expected: String, actual: String, label: String) -> String {
        let expectedLines = expected.components(separatedBy: "\n")
        let actualLines = actual.components(separatedBy: "\n")
        let commonCount = min(expectedLines.count, actualLines.count)

        var firstDiff = commonCount
        for index in 0..<commonCount where expectedLines[index] != actualLines[index] {
            firstDiff = index
            break
        }
        if firstDiff == commonCount && expectedLines.count == actualLines.count {
            return "\(label): documents differ but no differing line found (line-ending issue?)"
        }

        let contextStart = max(0, firstDiff - 3)
        func window(_ lines: [String]) -> String {
            let end = min(lines.count, firstDiff + 4)
            guard contextStart < end else { return "  <past end of document>" }
            return lines[contextStart..<end].enumerated().map { offset, line in
                let lineNumber = contextStart + offset + 1
                let marker = (contextStart + offset) == firstDiff ? ">" : " "
                return String(format: "%@ %4d | %@", marker, lineNumber, line)
            }.joined(separator: "\n")
        }

        return """
        \(label): mismatch at line \(firstDiff + 1) \
        (expected \(expectedLines.count) lines, actual \(actualLines.count))
        --- expected (fixture) ---
        \(window(expectedLines))
        --- actual (port) ---
        \(window(actualLines))
        """
    }
}

// MARK: - Scripted transport

/// The scripted transport: serves queued `MessagesResponse`s FIFO and records
/// each request in the canonical shape the web harness pinned — `limit` only
/// for a latest page; `beforeAt`+`beforeSeq`+`limit` for older pages;
/// `afterAt`+`afterSeq`+`untilAt`+`untilSeq`+`epoch`+`limit` (untils
/// explicitly null on the first loop request) for tail catch-up.
actor ScriptedMessagesProvider: MessagesProviding {
    struct ScriptError: Error, LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    private var queue: [MessagesResponse] = []
    private(set) var requests: [JSONValue] = []

    var remaining: Int { queue.count }

    func begin(_ responses: [MessagesResponse]) {
        queue = responses
        requests = []
    }

    func messages(sessionId: String, query: MessagesPageQuery) async throws -> MessagesResponse {
        requests.append(Self.requestJSON(query))
        guard !queue.isEmpty else {
            throw ScriptError(message: "scripted MessagesProviding exhausted: unexpected getMessages request")
        }
        return queue.removeFirst()
    }

    func queuedState(sessionId: String, localIds: [String]) async throws -> QueuedStateResponse {
        // queued-state ops are replayed via store primitives, like the web runner.
        throw ScriptError(message: "scripted MessagesProviding does not serve queued-state")
    }

    private static func requestJSON(_ query: MessagesPageQuery) -> JSONValue {
        switch query {
        case .latest(let limit):
            return .object(["limit": .number(Double(limit))])
        case .before(let beforeAt, let beforeSeq, let limit):
            return .object([
                "beforeAt": .number(Double(beforeAt)),
                "beforeSeq": .number(Double(beforeSeq)),
                "limit": .number(Double(limit)),
            ])
        case .after(let afterAt, let afterSeq, let untilAt, let untilSeq, let epoch, let limit):
            return .object([
                "afterAt": .number(Double(afterAt)),
                "afterSeq": .number(Double(afterSeq)),
                "epoch": .number(Double(epoch)),
                "limit": .number(Double(limit)),
                "untilAt": untilAt.map { JSONValue.number(Double($0)) } ?? .null,
                "untilSeq": untilSeq.map { JSONValue.number(Double($0)) } ?? .null,
            ])
        }
    }
}

// MARK: - JSONValue accessors (test-local; the module's are internal)

extension JSONValue {
    fileprivate var objectValue: [String: JSONValue]? {
        if case .object(let value) = self { return value }
        return nil
    }

    fileprivate var arrayValue: [JSONValue]? {
        if case .array(let value) = self { return value }
        return nil
    }

    fileprivate var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    fileprivate var intValue: Int? {
        if case .number(let value) = self { return Int(value) }
        return nil
    }

    fileprivate subscript(key: String) -> JSONValue? {
        objectValue?[key]
    }
}
