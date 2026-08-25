import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking  // URLSession types live here on Linux
#endif
import HapiClient
import HapiProtocol
import Testing

// Store-test fixtures and helpers, mirroring the Android reference suite's
// `StoreTestFixtures.kt`. Server responses are built by encoding real wire
// models with the production coders, so the fixtures cannot drift from the
// schema.

struct StoreFixtureError: Error {
    let message: String
}

// MARK: - Wire model builders

func storeSummary(
    _ id: String,
    active: Bool = false,
    updatedAt: Int = 0,
    activeAt: Int = 0,
    pinned: Bool? = nil,
    globalPinned: Bool? = nil,
    pendingRequestsCount: Int = 0,
    metadataVersion: Int = 0,
    agentStateVersion: Int = 0,
    todosUpdatedAt: Int = 0,
    futureScheduledMessageCount: Int = 0,
    nextScheduledAt: Int? = nil
) -> SessionSummary {
    SessionSummary(
        id: id,
        active: active,
        thinking: false,
        activeAt: activeAt,
        updatedAt: updatedAt,
        pinned: pinned,
        globalPinned: globalPinned,
        metadata: nil,
        metadataVersion: metadataVersion,
        agentStateVersion: agentStateVersion,
        todosUpdatedAt: todosUpdatedAt,
        todoProgress: nil,
        pendingRequestsCount: pendingRequestsCount,
        pendingRequestKinds: [],
        pendingRequests: [],
        backgroundTaskCount: 0,
        futureScheduledMessageCount: futureScheduledMessageCount,
        nextScheduledAt: nextScheduledAt,
        model: nil,
        modelReasoningEffort: nil,
        effort: nil
    )
}

func storeSession(
    _ id: String,
    updatedAt: Int = 0,
    active: Bool = true,
    metadataVersion: Int = 1,
    agentStateVersion: Int = 1,
    todosUpdatedAt: Int? = 0
) -> Session {
    Session(
        id: id,
        namespace: "default",
        seq: 1,
        createdAt: 1,
        updatedAt: updatedAt,
        active: active,
        activeAt: 0,
        metadata: nil,
        metadataVersion: metadataVersion,
        agentState: nil,
        agentStateVersion: agentStateVersion,
        thinking: false,
        thinkingAt: 0,
        todosUpdatedAt: todosUpdatedAt
    )
}

func storeMachine(_ id: String, active: Bool = true, host: String? = nil) -> Machine {
    Machine(
        id: id,
        namespace: "default",
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: active,
        activeAt: 1,
        metadata: MachineMetadata(
            host: host ?? "\(id)-host",
            platform: "linux",
            happyCliVersion: "1.0.0"
        ),
        metadataVersion: 1,
        runnerState: nil,
        runnerStateVersion: 1
    )
}

// MARK: - JSON encoding (production coders)

func encodeJSON(_ value: some Encodable) throws -> String {
    let data = try HapiJSON.encoder.encode(value)
    guard let text = String(data: data, encoding: .utf8) else {
        throw StoreFixtureError(message: "non-UTF8 encoder output")
    }
    return text
}

func sessionsResponseJSON(_ sessions: SessionSummary...) throws -> String {
    try encodeJSON(SessionsResponse(sessions: sessions))
}

func sessionResponseJSON(_ session: Session) throws -> String {
    try encodeJSON(SessionResponse(session: session))
}

func machinesResponseJSON(_ machines: Machine...) throws -> String {
    try encodeJSON(MachinesResponse(machines: machines))
}

func fullSessionJSON(_ session: Session) throws -> String {
    try encodeJSON(session)
}

func machineJSON(_ machine: Machine) throws -> String {
    try encodeJSON(machine)
}

// MARK: - SyncEvent builders (decoded through the production union)

func decodeSyncEvent(_ json: String) throws -> SyncEvent {
    try HapiJSON.decoder.decode(SyncEvent.self, from: Data(json.utf8))
}

/// Builds a decoded `session-updated` event whose `data` is raw JSON text.
func sessionUpdatedEvent(_ sessionId: String, dataJSON: String?) throws -> SyncEvent {
    let data = dataJSON.map { ",\"data\":\($0)" } ?? ""
    return try decodeSyncEvent("{\"type\":\"session-updated\",\"sessionId\":\"\(sessionId)\"\(data)}")
}

func sessionAddedEvent(_ sessionId: String, dataJSON: String?) throws -> SyncEvent {
    let data = dataJSON.map { ",\"data\":\($0)" } ?? ""
    return try decodeSyncEvent("{\"type\":\"session-added\",\"sessionId\":\"\(sessionId)\"\(data)}")
}

func sessionRemovedEvent(_ sessionId: String) throws -> SyncEvent {
    try decodeSyncEvent("{\"type\":\"session-removed\",\"sessionId\":\"\(sessionId)\"}")
}

/// Decodes a `machine-updated` event and returns its discriminated data
/// (what `MachineStore.applyMachineEvent` consumes).
func machineUpdatedData(_ machineId: String, dataJSON: String?) throws -> MachineUpdatedData? {
    let data = dataJSON.map { ",\"data\":\($0)" } ?? ""
    let event = try decodeSyncEvent("{\"type\":\"machine-updated\",\"machineId\":\"\(machineId)\"\(data)}")
    guard case .machineUpdated(_, _, let payload) = event else {
        throw StoreFixtureError(message: "expected machine-updated, got \(event)")
    }
    return payload
}

// MARK: - Harness

/// Builds an `APIClient` over an arbitrary performer with valid stored
/// credentials (fresh JWT, so no refresh traffic interferes with the FIFO
/// stubs).
func makeStoreAPIClient(performer: any HTTPPerforming) throws -> APIClient {
    guard let baseURL = URL(string: testHubURLString) else {
        throw StoreFixtureError(message: "bad test hub URL")
    }
    let store = InMemoryCredentialStore()
    try store.store(HubCredentials(
        hubUrl: testHubURLString,
        accessToken: "access-token",
        jwt: freshJWT()
    ))
    let auth = AuthManager(baseURL: baseURL, credentialStore: store, performer: performer, now: { testNow })
    return APIClient(baseURL: baseURL, authManager: auth, performer: performer)
}

/// Fresh directory under the system temp dir; unique per call.
func makeTempDirectory() -> URL {
    FileManager.default.temporaryDirectory
        .appendingPathComponent("hapi-store-tests", isDirectory: true)
        .appendingPathComponent(UUID().uuidString, isDirectory: true)
}

/// Polls `condition` on the main actor until it holds (or records a failed
/// expectation on timeout). The stores schedule work with real (short)
/// delays, so waiting replaces the Android suite's virtual-time collection.
@MainActor
func expectEventually(
    timeout: Duration = .seconds(5),
    _ comment: Comment? = nil,
    _ condition: @MainActor () -> Bool
) async throws {
    let deadline = ContinuousClock.now.advanced(by: timeout)
    while !condition() {
        if ContinuousClock.now > deadline {
            Issue.record(comment ?? "condition not met within \(timeout)")
            throw StoreFixtureError(message: "expectEventually timeout")
        }
        try await Task.sleep(for: .milliseconds(10))
    }
}

// MARK: - Path-routing performer

/// Answers requests by longest-registered-first path prefix instead of FIFO —
/// for flows where a detail refetch and a list refetch run concurrently and
/// arrival order is not deterministic.
actor RoutingPerformer: HTTPPerforming {
    struct Route: Sendable {
        let pathPrefix: String
        let status: Int
        let json: String
    }

    private var routes: [Route] = []
    private(set) var requests: [URLRequest] = []

    /// Replaces all routes. Matching is first-match over the given order —
    /// register more specific prefixes first.
    func setRoutes(_ routes: [(pathPrefix: String, json: String)]) {
        self.routes = routes.map { Route(pathPrefix: $0.pathPrefix, status: 200, json: $0.json) }
    }

    func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        let path = request.url?.path ?? ""
        let match = routes.first { path.hasPrefix($0.pathPrefix) }
        let status = match?.status ?? 404
        let body = match?.json ?? "{\"error\":\"no route\"}"
        guard let url = request.url,
              let response = HTTPURLResponse(
                  url: url,
                  statusCode: status,
                  httpVersion: "HTTP/1.1",
                  headerFields: ["Content-Type": "application/json"]
              ) else {
            throw URLError(.badURL)
        }
        return (Data(body.utf8), response)
    }
}
