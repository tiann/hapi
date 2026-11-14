import HapiClient
import XCTest
@testable import Hapi
@testable import HapiProtocol

/// Notification tap-through across paired hubs: the payload carries no hub,
/// so the owner is located (active hub first) before navigating. Fake HTTP
/// and in-memory credentials; no Keychain or network.
@MainActor
final class NotificationRoutingTests: XCTestCase {
    private let hubA = "https://a.example.com"
    private let hubB = "https://b.example.com"

    /// Hub B owns `s-b`; hub A answers 404 for it. Hub C is offline.
    private actor OwnerHTTP: HTTPPerforming {
        private(set) var sessionLookups: [String] = []

        func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
            let url = try XCTUnwrap(request.url)
            let host = url.host ?? ""
            if url.path.hasPrefix("/api/sessions/") {
                sessionLookups.append(host)
            }
            if host == "c.example.com" { throw URLError(.cannotConnectToHost) }
            let owns = host == "b.example.com" && url.lastPathComponent == "s-b"
            let status = owns ? 200 : 404
            let body = owns
                ? #"{"session":{"id":"s-b","namespace":"default","seq":1,"createdAt":1,"updatedAt":1,"active":true,"activeAt":1,"metadata":null,"metadataVersion":1,"agentState":null,"agentStateVersion":1,"thinking":false,"thinkingAt":0}}"#
                : #"{"error":"Session not found"}"#
            let response = try XCTUnwrap(HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil))
            return (Data(body.utf8), response)
        }
    }

    /// A JWT the auth manager accepts without refreshing (expires in 2100).
    private static let jwt: String = {
        func encode(_ json: String) -> String {
            Data(json.utf8).base64EncodedString()
                .replacingOccurrences(of: "+", with: "-")
                .replacingOccurrences(of: "/", with: "_")
                .replacingOccurrences(of: "=", with: "")
        }
        return encode(#"{"alg":"HS256","typ":"JWT"}"#) + "."
            + encode(#"{"uid":1,"ns":"default","iat":1700000000,"exp":4102444800}"#) + ".signature"
    }()

    private func credentials(_ hubs: [String]) throws -> InMemoryCredentialStore {
        let store = InMemoryCredentialStore()
        for hub in hubs {
            try store.store(HubCredentials(hubUrl: hub, accessToken: "token", jwt: Self.jwt))
        }
        return store
    }

    func testLocateSkipsHubsThatDoNotKnowTheSession() async throws {
        let http = OwnerHTTP()
        let runner = PushActionRunner(
            hubs: [hubA, "https://c.example.com", hubB],
            credentialStore: try credentials([hubA, "https://c.example.com", hubB]),
            performer: http
        )

        guard case .success(let owner) = await runner.locate(sessionId: "s-b") else {
            return XCTFail("hub B owns the session")
        }
        XCTAssertEqual(owner, hubB)
        let missing = await runner.locate(sessionId: "s-gone")
        guard case .transient = missing else {
            return XCTFail("an unreachable hub keeps the miss inconclusive, got \(missing)")
        }
        let lookups = await http.sessionLookups
        XCTAssertEqual(Array(lookups.prefix(3)), ["a.example.com", "c.example.com", "b.example.com"])
    }

    func testTapSwitchesToTheOwningHubBeforeOpening() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "NotificationRoutingTests-\(UUID().uuidString)"))
        let registry = HubRegistry(defaults: defaults)
        registry.register(hubA)
        registry.register(hubB)
        registry.setActiveHub(hubA)
        let model = AppModel(registry: registry, credentialStore: try credentials([hubA, hubB]), performer: OwnerHTTP())
        XCTAssertEqual(model.state, .paired(activeHub: hubA))

        model.openNotificationTarget(sessionId: "s-b", hubUrl: hubB)
        XCTAssertEqual(model.state, .paired(activeHub: hubB))
        XCTAssertEqual(model.pendingOpenSessionId, "s-b")

        // No located owner (or an unpaired one): stay on the active hub.
        model.openNotificationTarget(sessionId: "s-x", hubUrl: nil)
        model.openNotificationTarget(sessionId: "s-y", hubUrl: "https://unpaired.example.com")
        XCTAssertEqual(model.state, .paired(activeHub: hubB))
        XCTAssertEqual(model.pendingOpenSessionId, "s-y")
    }
}
