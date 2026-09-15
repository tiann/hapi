import HapiClient
import HapiProtocol
import SwiftUI
import XCTest
@testable import Hapi

@MainActor
final class SessionConfigTests: XCTestCase {
    func testCollaborationMenuUsesLiveStateWithoutDependingOnTheModelCatalog() async throws {
        let harness = try await SessionConfigTestHarness(flavor: "codex")
        let model = harness.model
        XCTAssertTrue(model.showsCollaborationMode)
        XCTAssertEqual(model.collaborationMode, .default)
        await harness.http.setModelsFailure(true)
        model.loadModels()
        try await configEventually { model.modelLoadFailed }
        XCTAssertTrue(model.config.canChangeCollaborationMode)
        model.selectCollaborationMode(.plan)
        XCTAssertEqual(model.collaborationMode, .plan)
        XCTAssertEqual(model.permission, .default)
        try await configEventually { !model.isApplying }
        let posts = await harness.http.posts
        XCTAssertEqual(posts.first?.path, "/api/sessions/config/collaboration-mode")
        XCTAssertEqual(posts.first?.body, #"{"mode":"plan"}"#)
        harness.store.applySessionEvent(.sessionUpdated(namespace: nil, sessionId: "config", data: .patch(SessionPatch(collaborationMode: .default))))
        XCTAssertEqual(model.collaborationMode, .default)
        harness.store.updateDetailLocal("config") { $0.active = false }
        XCTAssertTrue(model.showsCollaborationMode)
        model.selectCollaborationMode(.plan)
        let finalPosts = await harness.http.posts
        XCTAssertEqual(finalPosts.count, 1)
        let claude = try await SessionConfigTestHarness()
        XCTAssertFalse(claude.model.showsCollaborationMode)
    }

    func testClaudeDefaultsAndUnknownValuesKeepTheirCatalogSemantics() async throws {
        let harness = try await SessionConfigTestHarness()
        let model = harness.model
        for value in [nil, "auto", "default", "  "] as [String?] {
            harness.store.updateDetailLocal("config") {
                $0.model = value
                $0.effort = value
            }
            XCTAssertNil(model.currentModel)
            XCTAssertEqual(model.modelLabel, "Default")
            XCTAssertNil(model.currentEffort)
            XCTAssertEqual(model.effortOptions.first?.label, "Auto")
        }
        harness.store.updateDetailLocal("config") {
            $0.model = " custom-model "
            $0.effort = " TURBO "
        }
        XCTAssertEqual(model.currentModel, "custom-model")
        XCTAssertEqual(model.modelLabel, "custom-model")
        XCTAssertNil(model.unlistedModelOption, "Claude's catalog includes its synthetic current row")
        XCTAssertEqual(model.currentEffort, "turbo")
        XCTAssertTrue(model.canSelectEffort("turbo"))
        XCTAssertEqual(model.effortOptions[1].label, "Turbo")
    }

    func testCodexDefaultIsNotTheFirstItemAndUnknownModelsAreNotCoerced() async throws {
        let harness = try await SessionConfigTestHarness(flavor: "codex")
        harness.model.loadModels()
        try await configEventually { !harness.model.config.modelOptionsLoading }
        XCTAssertEqual(harness.model.currentModel, "deep")
        XCTAssertEqual(harness.model.modelLabel, "Deep · default")
        harness.model.selectModel("deep")
        let initialPosts = await harness.http.posts
        XCTAssertTrue(initialPosts.isEmpty, "Selecting the effective default must not send a redundant POST")
        harness.store.updateDetailLocal("config") { $0.model = "custom-codex" }
        XCTAssertEqual(harness.model.modelLabel, "custom-codex")
        XCTAssertEqual(harness.model.unlistedModelOption, CatalogOption(value: "custom-codex", label: "custom-codex"))
        harness.model.selectModel("custom-codex")
        let posts = await harness.http.posts
        XCTAssertTrue(posts.isEmpty, "An unlisted model is displayed, not offered as a new edit")
    }

    func testCodexCatalogWithoutDefaultKeepsAnUnselectedReadOnlyMenuTag() async throws {
        let harness = try await SessionConfigTestHarness(flavor: "codex")
        await harness.http.setModels([
            CodexModelSummary(id: "fast", displayName: "Fast", isDefault: false),
        ])
        harness.model.loadModels()
        try await configEventually { !harness.model.config.modelOptionsLoading }
        XCTAssertNil(harness.model.currentModel)
        XCTAssertEqual(harness.model.unlistedModelOption, CatalogOption(value: nil, label: "Default"))
        harness.model.selectModel(nil)
        let posts = await harness.http.posts
        XCTAssertTrue(posts.isEmpty, "A synthetic nil tag is display-only, not an unsupported edit")
    }

    func testPendingCodexChangeAlsoGuardsCollaborationAndCatalogReloads() async throws {
        let harness = try await SessionConfigTestHarness(flavor: "codex")
        harness.model.loadModels()
        try await configEventually { !harness.model.config.modelOptionsLoading }
        await harness.http.holdPosts()
        defer { Task { await harness.http.releasePosts() } }
        harness.model.selectModel("fast")
        harness.model.selectCollaborationMode(.plan)
        harness.model.selectPermission(.yolo)
        harness.model.selectEffort("high")
        harness.model.loadModels()
        try await configEventually { await harness.http.posts.count == 1 }
        XCTAssertEqual(harness.model.collaborationMode, .default)
        XCTAssertEqual(harness.model.permission, .default)
        let requests = await harness.http.modelRequests
        XCTAssertEqual(requests, 1)
    }

    func testSelectionSkipsUnchangedValuesAndGuardsAllEditsWhileApplying() async throws {
        let harness = try await SessionConfigTestHarness(model: "sonnet")
        let model = harness.model
        model.selectPermission(.default)
        model.selectModel("sonnet")
        model.selectEffort(nil)
        let initialPosts = await harness.http.posts
        XCTAssertTrue(initialPosts.isEmpty)

        await harness.http.holdPosts()
        defer { Task { await harness.http.releasePosts() } }
        model.selectModel("opus")
        XCTAssertEqual(model.modelLabel, "Opus")
        XCTAssertTrue(model.isApplying)
        model.selectModel("sonnet")
        model.selectPermission(.plan)
        model.selectEffort("high")
        try await configEventually { await harness.http.posts.count == 1 }
        let posts = await harness.http.posts
        XCTAssertEqual(posts.first?.path, "/api/sessions/config/model")
        XCTAssertEqual(posts.first?.body, #"{"model":"opus"}"#)

        await harness.http.releasePosts()
        try await configEventually { !model.isApplying }
        model.selectEffort("high")
        try await configEventually { !model.isApplying }
        let finalPosts = await harness.http.posts
        XCTAssertEqual(finalPosts.count, 2)
        XCTAssertEqual(finalPosts.last?.path, "/api/sessions/config/effort")
    }

    func testModelSwitchUpdatesEffortMenuWithoutSilentlyChangingStaleEffort() async throws {
        let harness = try await SessionConfigTestHarness(flavor: "codex", model: "deep")
        harness.store.updateDetailLocal("config") { $0.modelReasoningEffort = "xhigh" }
        let model = harness.model
        model.loadModels()
        try await configEventually { !model.config.modelOptionsLoading }
        XCTAssertTrue(model.canSelectEffort("xhigh"))
        model.selectModel("fast")
        XCTAssertEqual(model.currentEffort, "xhigh")
        XCTAssertEqual(model.effortOptions.first?.value, "xhigh")
        XCTAssertFalse(model.canSelectEffort("xhigh"), "Keep the stale tag read-only, not a supported option")
        XCTAssertTrue(model.canSelectEffort("low"))
        try await configEventually { !model.isApplying }
        model.selectEffort("xhigh")
        model.selectEffort("low")
        try await configEventually { !model.isApplying }
        let posts = await harness.http.posts
        XCTAssertEqual(posts.count, 2)
        XCTAssertEqual(posts.last?.path, "/api/sessions/config/model-reasoning-effort")
        XCTAssertEqual(posts.last?.body, #"{"modelReasoningEffort":"low"}"#)
        XCTAssertEqual(model.currentEffort, "low")
    }

    func testFailureReloadsServerTruthAndPreservesTheOwnersNoticeCallback() async throws {
        let harness = try await SessionConfigTestHarness()
        await harness.http.rejectChanges()
        var notices: [String] = []
        harness.interactor.onEvent = {
            if case .notice(let message) = $0 { notices.append(message) }
        }
        harness.model.selectPermission(.plan)
        XCTAssertEqual(harness.model.permission, .plan)
        try await configEventually { !harness.model.isApplying }
        XCTAssertEqual(harness.model.permission, .default)
        XCTAssertEqual(notices, ["HTTP 409 (Config rejected)"])
    }

    func testModelFailureRetriesAndLoadedEmptyCatalogIsUnavailableNotFailed() async throws {
        let harness = try await SessionConfigTestHarness(flavor: "codex")
        await harness.http.setModelsFailure(true)
        harness.model.loadModels()
        XCTAssertTrue(harness.model.config.modelOptionsLoading)
        XCTAssertFalse(harness.model.showsEffort)
        try await configEventually { harness.model.modelLoadFailed }
        await harness.http.setModelsFailure(false)
        harness.model.loadModels()
        try await configEventually { !harness.model.config.modelOptionsLoading }
        XCTAssertFalse(harness.model.modelLoadFailed)
        XCTAssertTrue(harness.model.showsEffort)
        let count = await harness.http.modelRequests
        XCTAssertEqual(count, 2)

        let empty = try await SessionConfigTestHarness(flavor: "codex")
        await empty.http.setModels([])
        empty.model.loadModels()
        try await configEventually { !empty.model.config.modelOptionsLoading }
        XCTAssertEqual(empty.model.config.modelOptions, [])
        XCTAssertFalse(empty.model.modelLoadFailed)
        XCTAssertTrue(empty.model.showsModel)
        XCTAssertFalse(empty.model.showsEffort)
    }

    func testCapabilitiesAndUnsupportedAgentsRemainCatalogDriven() async throws {
        for flavor in ["pi", "dsh"] {
            let harness = try await SessionConfigTestHarness(flavor: flavor)
            XCTAssertFalse(harness.model.hasSettings)
            harness.model.selectPermission(.yolo)
            harness.model.selectModel("opus")
            harness.model.selectEffort("high")
            let posts = await harness.http.posts
            XCTAssertTrue(posts.isEmpty)
        }
        let harness = try await SessionConfigTestHarness(flavor: "codex")
        harness.store.updateDetailLocal("config") {
            $0.active = false
            $0.agentState = AgentState(controlledByUser: true)
            $0.metadata?.capabilities = SessionCapabilities(concurrentClients: true)
        }
        XCTAssertFalse(harness.model.config.active)
        XCTAssertFalse(harness.model.config.controlledByUser)
        XCTAssertFalse(harness.model.config.permissionModes.contains { $0.mode == .safeYolo })
        harness.model.selectPermission(.safeYolo)
        let posts = await harness.http.posts
        XCTAssertTrue(posts.isEmpty)
        // Offline/terminal notices do not introduce a blanket UI authorization gate.
        harness.store.updateDetailLocal("config") { $0.metadata?.capabilities = nil }
        XCTAssertTrue(harness.model.config.controlledByUser)
        XCTAssertTrue(harness.model.config.permissionModes.contains { $0.mode == .safeYolo })
    }
}

/// Real app model, interactor, store and API over fake HTTP. No hub connection,
/// Keychain, window activation, saved drafts, or shared conformance fixtures.
@MainActor
final class SessionConfigTestHarness {
    let http: SessionConfigTestHTTP
    let store: SessionListStore
    let interactor: ChatInteractor
    let model: SessionConfigModel

    init(flavor: String = "claude", model: String? = nil) async throws {
        let detail = Session(
            id: "config", namespace: "test", seq: 1, createdAt: 1, updatedAt: 1,
            active: true, activeAt: 1,
            metadata: SessionMetadata(path: "/repo/app", host: "test", flavor: flavor),
            metadataVersion: 1, agentState: nil, agentStateVersion: 1,
            thinking: false, thinkingAt: 0, model: model, permissionMode: .default
        )
        let http = SessionConfigTestHTTP(detail: detail)
        self.http = http
        let baseURL = URL(string: "http://127.0.0.1:1")!
        let credentials = InMemoryCredentialStore()
        let payload = Data(#"{"uid":1,"exp":4102444800,"ns":"test"}"#.utf8).base64EncodedString()
        try credentials.store(HubCredentials(
            hubUrl: baseURL.absoluteString, accessToken: "test", jwt: "e30.\(payload).test"
        ))
        let auth = AuthManager(baseURL: baseURL, credentialStore: credentials, performer: http)
        let api = APIClient(baseURL: baseURL, authManager: auth, performer: http)
        store = SessionListStore(api: api)
        try await store.loadSessionDetail("config")
        interactor = ChatInteractor(
            sessionId: "config", api: api, sessionStore: store,
            windows: MessageWindowControllers(provider: api)
        )
        self.model = SessionConfigModel(interactor: interactor)
    }
}

actor SessionConfigTestHTTP: HTTPPerforming {
    struct Post: Sendable {
        let path: String
        let body: String?
    }

    private let detail: Session
    private var models = [
        CodexModelSummary(id: "fast", displayName: "Fast", isDefault: false, supportedReasoningEfforts: ["low", "high"]),
        CodexModelSummary(id: "deep", displayName: "Deep", isDefault: true, supportedReasoningEfforts: ["high", "xhigh"]),
    ]
    private var modelsFailure = false
    private var changesRejected = false
    private var postsHeld = false
    private var postWaiters: [CheckedContinuation<Void, Never>] = []
    private(set) var posts: [Post] = []
    private(set) var modelRequests = 0

    init(detail: Session) { self.detail = detail }
    func setModelsFailure(_ value: Bool) { modelsFailure = value }
    func setModels(_ values: [CodexModelSummary]) { models = values }
    func rejectChanges() { changesRejected = true }
    func holdPosts() { postsHeld = true }
    func releasePosts() {
        postsHeld = false
        let waiters = postWaiters
        postWaiters.removeAll()
        for waiter in waiters { waiter.resume() }
    }

    func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let url = try XCTUnwrap(request.url)
        let path = url.path
        let data: Data
        var status = 200
        if request.httpMethod == "POST" {
            posts.append(Post(path: path, body: request.httpBody.map { String(decoding: $0, as: UTF8.self) }))
            if postsHeld { await withCheckedContinuation { postWaiters.append($0) } }
            status = changesRejected ? 409 : 200
            data = Data((changesRejected ? #"{"error":"Config rejected"}"# : #"{"ok":true}"#).utf8)
        } else if path.hasSuffix("/codex-models") {
            modelRequests += 1
            data = try HapiJSON.encoder.encode(CodexModelsResponse(
                success: !modelsFailure, models: modelsFailure ? nil : models,
                error: modelsFailure ? "Catalog unavailable" : nil
            ))
        } else if path == "/api/sessions/config" {
            data = try HapiJSON.encoder.encode(SessionResponse(session: detail))
        } else {
            throw URLError(.unsupportedURL)
        }
        return (data, try XCTUnwrap(HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)))
    }
}

@MainActor
func configEventually(
    file: StaticString = #filePath, line: UInt = #line,
    _ condition: () async -> Bool
) async throws {
    for _ in 0..<200 {
        if await condition() { return }
        try await Task.sleep(for: .milliseconds(10))
    }
    XCTFail("Timed out waiting for session config state", file: file, line: line)
}
