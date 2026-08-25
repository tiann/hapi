import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking  // URLSession types live here on Linux
#endif
import HapiClient
import HapiProtocol
import Testing

// Transcription of the Android reference suite
// (`ChatViewModelInteractionTest.kt`) against the iOS `ChatInteractor`. The
// interactor runs over the REAL `APIClient`/`AuthManager`/`SessionListStore`/
// `MessageWindowControllers`, with only HTTP scripted (route-based recording
// performer) — so wire bodies are asserted as the canonical JSON the app
// actually sends (`HapiJSON.encoder` sorts keys deterministically).

private let chatSessionID = "sess-1"

// MARK: - Routing performer

/// Answers by (method, exact path) — scripted FIFOs first, then persistent
/// exact routes, then persistent suffix handlers, then `200 {}` — and records
/// every exchange for body/path assertions.
private actor ChatRoutingPerformer: HTTPPerforming {
    struct Exchange: Sendable {
        let method: String
        let path: String
        let body: String?
    }

    private(set) var exchanges: [Exchange] = []
    private var scripted: [String: [(status: Int, json: String)]] = [:]
    private var served: [String: (status: Int, json: String)] = [:]
    private var suffixRoutes: [(method: String, suffix: String, handler: @Sendable (URLRequest) -> (Int, String))] = []
    private var gatedRoutes: [(method: String, suffix: String)] = []
    private var gateWaiters: [CheckedContinuation<Void, Never>] = []

    /// One-shot response for an exact `path`, consumed in FIFO order.
    func script(_ method: String, _ path: String, status: Int = 200, json: String = "{}") {
        scripted["\(method) \(path)", default: []].append((status, json))
    }

    /// Persistent response for an exact `path` (later calls replace it).
    func serve(_ method: String, _ path: String, status: Int = 200, json: String) {
        served["\(method) \(path)"] = (status, json)
    }

    /// Persistent computed response for any path ending in `suffix`.
    func serveSuffix(
        _ method: String,
        _ suffix: String,
        handler: @escaping @Sendable (URLRequest) -> (Int, String)
    ) {
        suffixRoutes.append((method, suffix, handler))
    }

    /// Parks matching requests (after recording them) until ``openGates()``
    /// — in-flight-state tests.
    func gate(_ method: String, pathSuffix: String) {
        gatedRoutes.append((method, pathSuffix))
    }

    func openGates() {
        gatedRoutes = []
        let waiters = gateWaiters
        gateWaiters = []
        for waiter in waiters {
            waiter.resume()
        }
    }

    func bodies(_ method: String, pathSuffix: String) -> [String] {
        exchanges
            .filter { $0.method == method && $0.path.hasSuffix(pathSuffix) }
            .compactMap(\.body)
    }

    func count(_ method: String, pathSuffix: String) -> Int {
        exchanges.filter { $0.method == method && $0.path.hasSuffix(pathSuffix) }.count
    }

    func paths(_ method: String, pathSuffix: String) -> [String] {
        exchanges.filter { $0.method == method && $0.path.hasSuffix(pathSuffix) }.map(\.path)
    }

    func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let method = request.httpMethod ?? "GET"
        let path = request.url?.path ?? ""
        exchanges.append(Exchange(
            method: method,
            path: path,
            body: request.httpBody.map { String(decoding: $0, as: UTF8.self) }
        ))
        if gatedRoutes.contains(where: { $0.method == method && path.hasSuffix($0.suffix) }) {
            await withCheckedContinuation { continuation in
                gateWaiters.append(continuation)
            }
        }
        let key = "\(method) \(path)"
        let status: Int
        let json: String
        if var queue = scripted[key], !queue.isEmpty {
            (status, json) = queue.removeFirst()
            scripted[key] = queue
        } else if let exact = served[key] {
            (status, json) = exact
        } else if let route = suffixRoutes.first(where: { $0.method == method && path.hasSuffix($0.suffix) }) {
            (status, json) = route.handler(request)
        } else {
            (status, json) = (200, "{}")
        }
        guard let url = request.url,
              let response = HTTPURLResponse(
                  url: url,
                  statusCode: status,
                  httpVersion: "HTTP/1.1",
                  headerFields: ["Content-Type": "application/json"]
              ) else {
            throw URLError(.badURL)
        }
        return (Data(json.utf8), response)
    }
}

// MARK: - Fakes & builders

@MainActor
private final class InMemoryChatDrafts: ChatDrafts {
    var storage: [String: String] = [:]

    func load(sessionId: String) -> String? { storage[sessionId] }

    func save(sessionId: String, text: String) {
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            storage[sessionId] = nil
        } else {
            storage[sessionId] = text
        }
    }

    func clear(sessionId: String) { storage[sessionId] = nil }

    func move(fromSessionId: String, toSessionId: String) {
        guard let draft = storage.removeValue(forKey: fromSessionId) else { return }
        if storage[toSessionId]?.isEmpty != false {
            storage[toSessionId] = draft
        }
    }
}

private func chatDetail(
    id: String = chatSessionID,
    flavor: String = "claude",
    active: Bool = true,
    thinking: Bool = false,
    permissionMode: PermissionMode? = .default,
    model: String? = nil,
    effort: String? = nil,
    agentState: AgentState? = nil
) -> Session {
    Session(
        id: id,
        namespace: "default",
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: active,
        activeAt: 0,
        metadata: SessionMetadata(path: "/repo/app", host: "devbox", flavor: flavor),
        metadataVersion: 1,
        agentState: agentState,
        agentStateVersion: 1,
        thinking: thinking,
        thinkingAt: 0,
        model: model,
        effort: effort,
        permissionMode: permissionMode
    )
}

private func bashRequest(_ command: String = "rm -rf build") -> AgentStateRequest {
    AgentStateRequest(tool: "Bash", arguments: .object(["command": .string(command)]))
}

/// Server-echoed queued row (`id != localId`, explicit `invokedAt: null` via
/// the wire collapse in `WindowMessage(wire:)`).
private func queuedServerRow(id: String, localId: String, text: String) -> DecryptedMessage {
    DecryptedMessage(
        id: id,
        seq: 7,
        localId: localId,
        content: .object([
            "role": .string("user"),
            "content": .object([
                "type": .string("text"),
                "text": .string(text),
            ]),
        ]),
        createdAt: 500,
        invokedAt: nil
    )
}

private func messageJSON(id: String, localId: String, text: String, invokedAt: Int) -> String {
    """
    {"id":"\(id)","seq":7,"localId":"\(localId)","createdAt":500,"invokedAt":\(invokedAt),\
    "content":{"role":"user","content":{"type":"text","text":"\(text)"}}}
    """
}

// MARK: - Harness

@MainActor
private final class ChatInteractionHarness {
    let performer: ChatRoutingPerformer
    let api: APIClient
    let store: SessionListStore
    let windows: MessageWindowControllers
    let drafts: InMemoryChatDrafts
    let interactor: ChatInteractor
    private(set) var events: [ChatInteractionEvent] = []

    let sessionID: String

    init(detail: Session = chatDetail(), activate: Bool = true) async throws {
        sessionID = detail.id
        let performer = ChatRoutingPerformer()
        self.performer = performer

        // Empty pages for every window sync; direction mirrors the query so
        // an after-catch-up never masquerades as a reset (Android fake note).
        await performer.serveSuffix("GET", "/messages") { request in
            let items = request.url
                .flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false)?.queryItems } ?? []
            let names = Set(items.map(\.name))
            let direction = names.contains("afterAt")
                ? "after"
                : names.contains("beforeAt") ? "before" : "latest"
            let json = """
            {"messages":[],"page":{"direction":"\(direction)","limit":200,"epoch":1,\
            "reset":false,"hasMore":false}}
            """
            return (200, json)
        }
        // Queued-state reconcile: everything asked about is still queued.
        await performer.serveSuffix("POST", "/messages/queued-state") { request in
            struct Probe: Decodable { let localIds: [String] }
            var queued = "[]"
            if let body = request.httpBody,
               let probe = try? JSONDecoder().decode(Probe.self, from: body) {
                queued = "[" + probe.localIds.map { "\"\($0)\"" }.joined(separator: ",") + "]"
            }
            return (200, "{\"queuedLocalIds\":\(queued),\"invokedLocalMessages\":[]}")
        }
        await performer.serve("GET", "/api/sessions", json: "{\"sessions\":[]}")
        // Uploads succeed with a filename-derived path (Android fake parity).
        await performer.serveSuffix("POST", "/upload") { request in
            struct UploadBody: Decodable { let filename: String }
            let filename = request.httpBody
                .flatMap { try? JSONDecoder().decode(UploadBody.self, from: $0) }?
                .filename ?? "file"
            return (200, "{\"success\":true,\"path\":\"/uploads/\(filename)\"}")
        }
        await performer.serveSuffix("POST", "/upload/delete") { _ in
            (200, "{\"success\":true}")
        }

        let baseURL = try #require(URL(string: testHubURLString))
        let credentials = InMemoryCredentialStore()
        try credentials.store(HubCredentials(
            hubUrl: testHubURLString,
            accessToken: "access-token",
            jwt: freshJWT()
        ))
        let auth = AuthManager(
            baseURL: baseURL,
            credentialStore: credentials,
            performer: performer,
            now: { testNow }
        )
        let api = APIClient(baseURL: baseURL, authManager: auth, performer: performer)
        self.api = api
        store = SessionListStore(api: api)
        windows = MessageWindowControllers(provider: api)
        drafts = InMemoryChatDrafts()

        var localIdCounter = 0
        interactor = ChatInteractor(
            sessionId: detail.id,
            api: api,
            sessionStore: store,
            windows: windows,
            drafts: drafts,
            draftSaveDebounce: .milliseconds(10),
            now: { 1_000 },
            makeLocalId: {
                localIdCounter += 1
                return "local-\(localIdCounter)"
            }
        )
        interactor.onEvent = { [weak self] event in
            self?.events.append(event)
        }

        try await serveDetail(detail)
        _ = try await store.loadSessionDetail(detail.id)
        if activate {
            interactor.activate()
        }
    }

    /// Sets the detail `GET /api/sessions/:id` will answer from now on (the
    /// "server truth" for rollbacks and settle-patches), without loading it.
    func serveDetail(_ detail: Session) async throws {
        let data = try HapiJSON.encoder.encode(SessionResponse(session: detail))
        await performer.serve(
            "GET",
            "/api/sessions/\(detail.id)",
            json: String(decoding: data, as: UTF8.self)
        )
    }

    func window(_ sessionId: String? = nil) async -> MessageWindowController {
        await windows.open(sessionId: sessionId ?? sessionID)
    }

    func row(localId: String, in sessionId: String? = nil) async -> WindowMessage? {
        await window(sessionId).state.messages.first { $0.localId == localId }
    }
}

/// Polls `condition` (10 ms cadence) until true or `timeout`; returns the
/// final verdict for `#expect`.
@MainActor
private func eventually(
    timeout: Duration = .seconds(5),
    _ condition: @MainActor () async -> Bool
) async -> Bool {
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: timeout)
    while clock.now < deadline {
        if await condition() { return true }
        try? await Task.sleep(for: .milliseconds(10))
    }
    return await condition()
}

// MARK: - Tests

@Suite("ChatInteractor")
@MainActor
struct ChatInteractorTests {

    // MARK: Send

    @Test func optimisticSendHappyPathPostsQueueDeliveryAndSettlesToSent() async throws {
        let harness = try await ChatInteractionHarness()

        harness.interactor.setComposerText("hello agent")
        harness.interactor.sendMessage()

        #expect(await eventually {
            await harness.row(localId: "local-1")?.status == .sent
        })
        let sends = await harness.performer.bodies("POST", pathSuffix: "/api/sessions/sess-1/messages")
        #expect(sends == [#"{"deliveryMode":"queue","localId":"local-1","text":"hello agent"}"#])
        // Optimistic until the SSE echo replaces it.
        #expect(await harness.row(localId: "local-1")?.id == "local-1")
        #expect(harness.interactor.composerText.isEmpty)
        #expect(harness.drafts.storage[chatSessionID] == nil)
    }

    @Test func sendWhileThinkingSettlesToQueuedAndSteerIntentRidesTheWire() async throws {
        let harness = try await ChatInteractionHarness(detail: chatDetail(thinking: true))

        harness.interactor.setComposerText("steer this")
        harness.interactor.sendMessage(steer: true)

        #expect(await eventually {
            await harness.row(localId: "local-1")?.status == .queued
        })
        let sends = await harness.performer.bodies("POST", pathSuffix: "/api/sessions/sess-1/messages")
        #expect(sends == [#"{"deliveryMode":"steer","localId":"local-1","text":"steer this"}"#])
    }

    @Test func failedSendMarksTheRowFailedAndRetryRefiresWithTheSameLocalId() async throws {
        let harness = try await ChatInteractionHarness()
        await harness.performer.script(
            "POST", "/api/sessions/sess-1/messages",
            status: 500, json: #"{"error":"boom"}"#
        )

        harness.interactor.setComposerText("try me")
        harness.interactor.sendMessage()
        #expect(await eventually {
            await harness.row(localId: "local-1")?.status == .failed
        })

        harness.interactor.retryFailedMessage(localId: "local-1")
        #expect(await eventually {
            await harness.row(localId: "local-1")?.status == .sent
        })
        let sends = await harness.performer.bodies("POST", pathSuffix: "/api/sessions/sess-1/messages")
        #expect(sends.count == 2)
        // Retry never re-binds a steer intent; durable queue only.
        #expect(sends[1] == #"{"deliveryMode":"queue","localId":"local-1","text":"try me"}"#)
    }

    @Test func sessionInactiveResumesOnceAndRetriesAgainstTheSameId() async throws {
        let harness = try await ChatInteractionHarness(
            detail: chatDetail(active: false, permissionMode: .acceptEdits)
        )
        await harness.performer.script(
            "POST", "/api/sessions/sess-1/messages",
            status: 409, json: #"{"error":"Session is inactive","code":"session_inactive"}"#
        )
        await harness.performer.serve(
            "POST", "/api/sessions/sess-1/resume",
            json: #"{"sessionId":"sess-1"}"#
        )

        harness.interactor.setComposerText("wake up")
        harness.interactor.sendMessage()

        #expect(await eventually {
            await harness.row(localId: "local-1")?.status == .sent
        })
        let resumes = await harness.performer.bodies("POST", pathSuffix: "/resume")
        #expect(resumes == [#"{"permissionMode":"acceptEdits"}"#])
        let sendCount = await harness.performer.count("POST", pathSuffix: "/api/sessions/sess-1/messages")
        #expect(sendCount == 2)
        // Resume success reflects activity locally.
        #expect(harness.store.detail(for: chatSessionID)?.active == true)
    }

    @Test func sessionInactiveResumeWithASupersedingIdMigratesTheSendAndEmitsTheEvent() async throws {
        let harness = try await ChatInteractionHarness(detail: chatDetail(active: false))
        await harness.performer.script(
            "POST", "/api/sessions/sess-1/messages",
            status: 409, json: #"{"error":"Session is inactive","code":"session_inactive"}"#
        )
        await harness.performer.serve(
            "POST", "/api/sessions/sess-1/resume",
            json: #"{"sessionId":"sess-2"}"#
        )

        harness.interactor.setComposerText("follow me")
        harness.interactor.sendMessage()

        #expect(await eventually {
            harness.events.contains(.sessionSuperseded(sessionId: "sess-2"))
        })
        // The retry targeted the superseding session…
        let targetSends = await harness.performer.count("POST", pathSuffix: "/api/sessions/sess-2/messages")
        #expect(targetSends == 1)
        // …and the optimistic row lives (settled) in the new window only.
        #expect(await eventually {
            await harness.row(localId: "local-1", in: "sess-2")?.status == .sent
        })
        #expect(await harness.row(localId: "local-1") == nil)
        // The draft was cleared before the send; migration must not resurrect it.
        #expect(harness.drafts.storage["sess-2"] == nil)
    }

    // MARK: Attachments (A-M3f, transcribed from the Android VM suite)

    private func preparedShot(id: String = "att-1", filename: String = "shot.jpg") -> PreparedAttachment {
        PreparedAttachment(
            id: id,
            filename: filename,
            mimeType: "image/jpeg",
            bytes: Data([1, 2, 3]),
            previewBytes: Data([7, 7])
        )
    }

    /// The canonical send body for one `preparedShot` upload.
    private func attachmentSendBody(text: String, filename: String = "shot.jpg") -> String {
        let preview = AttachmentPolicy.dataUrl(mimeType: "image/jpeg", bytes: Data([7, 7]))
        return "{\"attachments\":[{\"filename\":\"\(filename)\",\"id\":\"att-1\","
            + "\"mimeType\":\"image/jpeg\",\"path\":\"/uploads/\(filename)\","
            + "\"previewUrl\":\"\(preview)\",\"size\":3}],"
            + "\"deliveryMode\":\"queue\",\"localId\":\"local-1\",\"text\":\"\(text)\"}"
    }

    @Test func sendRidesReadyAttachmentsAsWireMetadataAndTheOptimisticRowCarriesThem() async throws {
        let harness = try await ChatInteractionHarness()

        harness.interactor.attachments.add(preparedShot())
        #expect(await eventually { harness.interactor.attachments.allReady })
        harness.interactor.setComposerText("see the screenshot")
        harness.interactor.sendMessage()

        #expect(await eventually {
            await harness.row(localId: "local-1")?.status == .sent
        })
        let sends = await harness.performer.bodies("POST", pathSuffix: "/api/sessions/sess-1/messages")
        #expect(sends == [attachmentSendBody(text: "see the screenshot")])

        // The optimistic row carries the attachments — thumbnails render
        // before the SSE echo replaces it.
        let row = try #require(await harness.row(localId: "local-1"))
        let normalized = try #require(normalizeDecryptedMessage(row.asDecryptedMessage))
        guard case .user(_, let attachments) = normalized.content else {
            Issue.record("expected a user row")
            return
        }
        #expect(attachments?.map(\.filename) == ["shot.jpg"])

        // The tray was consumed by the send.
        #expect(harness.interactor.attachments.items.isEmpty)
    }

    @Test func attachmentsOnlySendPostsEmptyText() async throws {
        let harness = try await ChatInteractionHarness()

        harness.interactor.attachments.add(preparedShot())
        #expect(await eventually { harness.interactor.attachments.allReady })
        harness.interactor.sendMessage()

        #expect(await eventually {
            await harness.performer.count("POST", pathSuffix: "/api/sessions/sess-1/messages") == 1
        })
        // Wire allows text OR attachments — empty text rides along.
        let sends = await harness.performer.bodies("POST", pathSuffix: "/api/sessions/sess-1/messages")
        #expect(sends == [attachmentSendBody(text: "")])
    }

    @Test func sendRefusesWhileAnAttachmentUploadIsUnsettled() async throws {
        let harness = try await ChatInteractionHarness()
        await harness.performer.gate("POST", pathSuffix: "/upload")

        harness.interactor.attachments.add(preparedShot())
        // Upload started and parked on the gate.
        #expect(await eventually {
            await harness.performer.count("POST", pathSuffix: "/upload") == 1
        })
        harness.interactor.setComposerText("hold on")
        harness.interactor.sendMessage()

        #expect(await eventually {
            harness.events.contains { event in
                if case .notice(let message) = event { return message.contains("uploading") }
                return false
            }
        })
        let refusedSends = await harness.performer.count("POST", pathSuffix: "/api/sessions/sess-1/messages")
        #expect(refusedSends == 0)
        // The draft text and the chip both survive the refused send.
        #expect(harness.interactor.composerText == "hold on")
        #expect(harness.interactor.attachments.items.count == 1)

        // Once the upload settles, the same send goes through with metadata.
        await harness.performer.openGates()
        #expect(await eventually { harness.interactor.attachments.allReady })
        harness.interactor.sendMessage()
        #expect(await eventually {
            await harness.performer.count("POST", pathSuffix: "/api/sessions/sess-1/messages") == 1
        })
        let sends = await harness.performer.bodies("POST", pathSuffix: "/api/sessions/sess-1/messages")
        #expect(sends == [attachmentSendBody(text: "hold on")])
    }

    @Test func failedSendRetryReSendsTheSameAttachmentsFromTheWireRow() async throws {
        let harness = try await ChatInteractionHarness()
        await harness.performer.script(
            "POST", "/api/sessions/sess-1/messages",
            status: 500, json: #"{"error":"boom"}"#
        )

        harness.interactor.attachments.add(preparedShot())
        #expect(await eventually { harness.interactor.attachments.allReady })
        harness.interactor.setComposerText("try again")
        harness.interactor.sendMessage()
        #expect(await eventually {
            await harness.row(localId: "local-1")?.status == .failed
        })

        harness.interactor.retryFailedMessage(localId: "local-1")
        #expect(await eventually {
            await harness.row(localId: "local-1")?.status == .sent
        })

        let sends = await harness.performer.bodies("POST", pathSuffix: "/api/sessions/sess-1/messages")
        #expect(sends.count == 2)
        // Attachments round-tripped through the optimistic row's wire JSON —
        // the retry body is byte-identical (canonical sorted keys).
        #expect(sends[0] == sends[1])
        #expect(sends[1].contains("/uploads/shot.jpg"))
    }

    @Test func removingAReadyChipDeletesTheHubUploadAndDiscardDropsTheRest() async throws {
        let harness = try await ChatInteractionHarness()

        harness.interactor.attachments.add(preparedShot(id: "att-1", filename: "a.jpg"))
        #expect(await eventually { harness.interactor.attachments.allReady })
        harness.interactor.attachments.remove("att-1")
        #expect(await eventually {
            await harness.performer.bodies("POST", pathSuffix: "/upload/delete")
                == [#"{"path":"/uploads/a.jpg"}"#]
        })
        #expect(harness.interactor.attachments.items.isEmpty)

        // Un-sent leftovers are discarded when the screen goes away for good.
        harness.interactor.attachments.add(preparedShot(id: "att-2", filename: "b.jpg"))
        #expect(await eventually { harness.interactor.attachments.allReady })
        harness.interactor.discardAttachments()
        #expect(await eventually {
            await harness.performer.count("POST", pathSuffix: "/upload/delete") == 2
        })
        #expect(harness.interactor.attachments.items.isEmpty)
    }

    // MARK: Queued bar

    @Test func queuedCancelInvokedRaceIngestsTheAuthoritativeRowAsSent() async throws {
        let harness = try await ChatInteractionHarness()
        await harness.window().ingestSSEMessages([
            WindowMessage(wire: queuedServerRow(id: "srv-1", localId: "l-1", text: "queued text"))
        ])
        #expect(await eventually {
            harness.interactor.queuedRows.contains { $0.id == "srv-1" && $0.canAct }
        })

        await harness.performer.script(
            "DELETE", "/api/sessions/sess-1/messages/srv-1",
            json: #"{"status":"invoked","message":\#(messageJSON(id: "srv-1", localId: "l-1", text: "queued text", invokedAt: 900))}"#
        )
        harness.interactor.cancelQueuedMessage("srv-1")

        #expect(await eventually { harness.interactor.queuedRows.isEmpty })
        #expect(await eventually {
            let row = await harness.row(localId: "l-1")
            return row?.status == .sent && row?.invokedAtNumber == 900
        })
        let cancels = await harness.performer.count("DELETE", pathSuffix: "/messages/srv-1")
        #expect(cancels == 1)
    }

    @Test func steerPostsAndAnInvokedAnswerReconcilesAMissedConsume() async throws {
        let harness = try await ChatInteractionHarness(detail: chatDetail(thinking: true))
        await harness.window().ingestSSEMessages([
            WindowMessage(wire: queuedServerRow(id: "srv-2", localId: "l-2", text: "steer me"))
        ])
        #expect(await eventually {
            harness.interactor.queuedRows.contains { $0.id == "srv-2" && $0.canSteer }
        })

        await harness.performer.script(
            "POST", "/api/sessions/sess-1/messages/srv-2/steer",
            json: #"{"status":"invoked","message":\#(messageJSON(id: "srv-2", localId: "l-2", text: "steer me", invokedAt: 950))}"#
        )
        harness.interactor.steerQueuedMessage("srv-2")

        #expect(await eventually {
            await harness.row(localId: "l-2")?.invokedAtNumber == 950
        })
        let steers = await harness.performer.count("POST", pathSuffix: "/messages/srv-2/steer")
        #expect(steers == 1)
    }

    @Test func editCancelsAndPrefillsTheComposer() async throws {
        let harness = try await ChatInteractionHarness()
        await harness.window().ingestSSEMessages([
            WindowMessage(wire: queuedServerRow(id: "srv-3", localId: "l-3", text: "edit me"))
        ])
        #expect(await eventually {
            harness.interactor.queuedRows.contains { $0.id == "srv-3" && $0.canAct }
        })

        await harness.performer.script(
            "DELETE", "/api/sessions/sess-1/messages/srv-3",
            json: #"{"status":"cancelled","localId":"l-3"}"#
        )
        harness.interactor.editQueuedMessage("srv-3")

        #expect(await eventually { harness.interactor.composerText == "edit me" })
        let cancels = await harness.performer.count("DELETE", pathSuffix: "/messages/srv-3")
        #expect(cancels == 1)
    }

    // MARK: Permissions

    @Test func claudeApproveBodiesMatchTheWebPermissionFooterExactly() async throws {
        let requests: [String: AgentStateRequest] = [
            "r-allow": bashRequest(),
            "r-session": bashRequest("git push"),
            "r-edits": AgentStateRequest(tool: "Edit", arguments: .object(["file_path": .string("/a")])),
            "r-deny": bashRequest(),
        ]
        let harness = try await ChatInteractionHarness(
            detail: chatDetail(flavor: "claude", agentState: AgentState(requests: requests))
        )

        harness.interactor.resolvePermission(requestId: "r-allow", action: .allow)
        #expect(await eventually { await harness.performer.count("POST", pathSuffix: "/approve") == 1 })
        harness.interactor.resolvePermission(requestId: "r-session", action: .allowForSession)
        #expect(await eventually { await harness.performer.count("POST", pathSuffix: "/approve") == 2 })
        harness.interactor.resolvePermission(requestId: "r-edits", action: .allowAllEdits)
        #expect(await eventually { await harness.performer.count("POST", pathSuffix: "/approve") == 3 })
        harness.interactor.resolvePermission(requestId: "r-deny", action: .deny)
        #expect(await eventually { await harness.performer.count("POST", pathSuffix: "/deny") == 1 })

        let approveBodies = await harness.performer.bodies("POST", pathSuffix: "/approve")
        #expect(approveBodies == [
            #"{}"#,
            #"{"allowTools":["Bash(git push)"]}"#,
            #"{"mode":"acceptEdits"}"#,
        ])
        let approvePaths = await harness.performer.paths("POST", pathSuffix: "/approve")
        #expect(approvePaths == [
            "/api/sessions/sess-1/permissions/r-allow/approve",
            "/api/sessions/sess-1/permissions/r-session/approve",
            "/api/sessions/sess-1/permissions/r-edits/approve",
        ])
        let denyBodies = await harness.performer.bodies("POST", pathSuffix: "/deny")
        #expect(denyBodies == [#"{}"#])
    }

    @Test func codexFamilyApproveAndAbortBodiesUseDecisions() async throws {
        let requests: [String: AgentStateRequest] = [
            "r-yes": AgentStateRequest(tool: "CodexBash", arguments: .object(["command": .string("ls")])),
            "r-yes-session": AgentStateRequest(tool: "CodexBash"),
            "r-abort": AgentStateRequest(tool: "CodexBash"),
        ]
        let harness = try await ChatInteractionHarness(
            detail: chatDetail(flavor: "codex", agentState: AgentState(requests: requests))
        )

        harness.interactor.resolvePermission(requestId: "r-yes", action: .allow)
        #expect(await eventually { await harness.performer.count("POST", pathSuffix: "/approve") == 1 })
        harness.interactor.resolvePermission(requestId: "r-yes-session", action: .allowForSession)
        #expect(await eventually { await harness.performer.count("POST", pathSuffix: "/approve") == 2 })
        harness.interactor.resolvePermission(requestId: "r-abort", action: .abort)
        #expect(await eventually { await harness.performer.count("POST", pathSuffix: "/deny") == 1 })

        let approveBodies = await harness.performer.bodies("POST", pathSuffix: "/approve")
        #expect(approveBodies == [
            #"{"decision":"approved"}"#,
            #"{"decision":"approved_for_session"}"#,
        ])
        let denyBodies = await harness.performer.bodies("POST", pathSuffix: "/deny")
        #expect(denyBodies == [#"{"decision":"abort"}"#])
        let denyPaths = await harness.performer.paths("POST", pathSuffix: "/deny")
        #expect(denyPaths == ["/api/sessions/sess-1/permissions/r-abort/deny"])
    }

    @Test func answersPostFlatForAskUserQuestionAndNestedForRequestUserInput() async throws {
        let requests: [String: AgentStateRequest] = [
            "r-ask": AgentStateRequest(tool: "AskUserQuestion"),
            "r-input": AgentStateRequest(tool: "request_user_input"),
        ]
        let harness = try await ChatInteractionHarness(
            detail: chatDetail(flavor: "claude", agentState: AgentState(requests: requests))
        )

        harness.interactor.resolvePermission(
            requestId: "r-ask",
            action: .flatAnswers(["0": ["Option A", "free text"]])
        )
        #expect(await eventually { await harness.performer.count("POST", pathSuffix: "/approve") == 1 })
        harness.interactor.resolvePermission(
            requestId: "r-input",
            action: .nestedAnswers(["field1": ["Yes", "user_note: extra note"]])
        )
        #expect(await eventually { await harness.performer.count("POST", pathSuffix: "/approve") == 2 })

        let approveBodies = await harness.performer.bodies("POST", pathSuffix: "/approve")
        #expect(approveBodies == [
            #"{"answers":{"0":["Option A","free text"]}}"#,
            #"{"answers":{"field1":{"answers":["Yes","user_note: extra note"]}}}"#,
        ])
    }

    @Test func permission404BecomesTheBenignAlreadyHandledOverride() async throws {
        let harness = try await ChatInteractionHarness(
            detail: chatDetail(agentState: AgentState(requests: ["r-gone": bashRequest()]))
        )
        await harness.performer.script(
            "POST", "/api/sessions/sess-1/permissions/r-gone/approve",
            status: 404, json: #"{"error":"Request not found"}"#
        )

        harness.interactor.resolvePermission(requestId: "r-gone", action: .allow)

        #expect(await eventually {
            harness.interactor.permissionOverrides["r-gone"] == .alreadyHandled
        })
        #expect(harness.events.contains(.notice("Request was already handled")))
    }

    @Test func successfulResolveKeepsTheRowResolvingUntilTheAgentStatePatchSettlesIt() async throws {
        let harness = try await ChatInteractionHarness(
            detail: chatDetail(agentState: AgentState(requests: ["r-live": bashRequest()]))
        )

        harness.interactor.resolvePermission(requestId: "r-live", action: .allow)
        #expect(await eventually {
            harness.interactor.permissionOverrides["r-live"] == .resolving
        })
        #expect(await eventually { await harness.performer.count("POST", pathSuffix: "/approve") == 1 })
        // Still resolving after the POST succeeded — only the patch settles it.
        #expect(harness.interactor.permissionOverrides["r-live"] == .resolving)

        // The agentState patch lands (request moved to completedRequests).
        try await harness.serveDetail(chatDetail(agentState: AgentState(requests: [:])))
        _ = try await harness.store.loadSessionDetail(chatSessionID)
        #expect(harness.interactor.permissionOverrides.isEmpty)
    }

    // MARK: Config

    @Test func permissionModeSwitchAppliesOptimisticallyAndRollsBackToServerTruthOnError() async throws {
        let harness = try await ChatInteractionHarness(detail: chatDetail(permissionMode: .default))
        await harness.performer.script(
            "POST", "/api/sessions/sess-1/permission-mode",
            status: 409, json: #"{"error":"apply_failed","code":"apply_failed"}"#
        )

        harness.interactor.setPermissionMode(.acceptEdits)
        // Optimistic flip is visible synchronously in the detail cache.
        #expect(harness.store.detail(for: chatSessionID)?.permissionMode == .acceptEdits)

        // Rollback = reload server truth (served detail carries `default`).
        #expect(await eventually {
            harness.store.detail(for: chatSessionID)?.permissionMode == .default
        })
        #expect(await eventually {
            harness.events.contains { event in
                if case .notice = event { return true }
                return false
            }
        })
        let modeBodies = await harness.performer.bodies("POST", pathSuffix: "/permission-mode")
        #expect(modeBodies == [#"{"mode":"acceptEdits"}"#])
        let detailLoads = await harness.performer.count("GET", pathSuffix: "/api/sessions/sess-1")
        #expect(detailLoads >= 2)
    }

    @Test func modelAndEffortSwitchesRoutePerFlavor() async throws {
        let harness = try await ChatInteractionHarness(
            detail: chatDetail(flavor: "claude", model: "sonnet", effort: nil)
        )

        harness.interactor.setModel("opus")
        #expect(harness.store.detail(for: chatSessionID)?.model == "opus")
        #expect(await eventually {
            await harness.performer.count("POST", pathSuffix: "/model") == 1
                && !harness.interactor.configOpPending
        })
        let modelBodies = await harness.performer.bodies("POST", pathSuffix: "/model")
        #expect(modelBodies == [#"{"model":"opus"}"#])

        harness.interactor.setEffort("high")
        #expect(harness.store.detail(for: chatSessionID)?.effort == "high")
        #expect(await eventually {
            await harness.performer.count("POST", pathSuffix: "/effort") == 1
        })
        let effortBodies = await harness.performer.bodies("POST", pathSuffix: "/effort")
        #expect(effortBodies == [#"{"effort":"high"}"#])
    }

    @Test func codexEffortRoutesToModelReasoningEffort() async throws {
        let harness = try await ChatInteractionHarness(detail: chatDetail(flavor: "codex"))

        harness.interactor.setEffort("medium")

        #expect(await eventually {
            await harness.performer.count("POST", pathSuffix: "/model-reasoning-effort") == 1
        })
        let bodies = await harness.performer.bodies("POST", pathSuffix: "/model-reasoning-effort")
        #expect(bodies == [#"{"modelReasoningEffort":"medium"}"#])
        #expect(harness.store.detail(for: chatSessionID)?.modelReasoningEffort == "medium")
    }

    @Test func codexModelOptionsLoadThroughTheSessionCatalogEndpoint() async throws {
        let harness = try await ChatInteractionHarness(
            detail: chatDetail(flavor: "codex", model: "gpt-5.3-codex")
        )
        await harness.performer.serve(
            "GET", "/api/sessions/sess-1/codex-models",
            json: """
            {"success":true,"models":[{"id":"gpt-5.3-codex","displayName":"GPT-5.3 Codex",\
            "isDefault":true,"supportedReasoningEfforts":["low","medium","high"]}]}
            """
        )

        harness.interactor.loadModelOptions()

        #expect(await eventually {
            harness.interactor.config.modelOptions?.isEmpty == false
        })
        let config = harness.interactor.config
        #expect(config.modelOptions?.count == 1)
        #expect(config.modelOptions?.first?.value == "gpt-5.3-codex")
        #expect(config.modelOptions?.first?.label == "GPT-5.3 Codex · default")
        #expect(config.effortOptions?.map(\.value) == [nil, "low", "medium", "high"])
    }

    // MARK: Misc

    @Test func draftPersistsOnTypingAndRestoresOnOpen() async throws {
        let harness = try await ChatInteractionHarness(activate: false)
        harness.drafts.storage[chatSessionID] = "restored draft"
        harness.interactor.activate()

        #expect(await eventually { harness.interactor.composerText == "restored draft" })

        harness.interactor.setComposerText("newer draft")
        // Debounced persist (10 ms in this harness).
        #expect(await eventually { harness.drafts.storage[chatSessionID] == "newer draft" })
    }

    @Test func abortPostsConfirmFree() async throws {
        let harness = try await ChatInteractionHarness(detail: chatDetail(thinking: true))

        harness.interactor.abortSession()

        #expect(await eventually {
            await harness.performer.count("POST", pathSuffix: "/api/sessions/sess-1/abort") == 1
        })
    }
}
