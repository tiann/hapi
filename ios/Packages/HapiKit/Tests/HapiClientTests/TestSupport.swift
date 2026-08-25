import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking  // URLSession types live here on Linux
#endif
import HapiClient
import HapiProtocol
import Testing

// MARK: - JWT construction

func base64URLEncode(_ data: Data) -> String {
    data.base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}

/// A well-formed (unsigned) JWT with the hub's payload shape.
func makeJWT(uid: Int = 1, ns: String = "default", exp: Int? = nil) -> String {
    var fields = ["\"uid\":\(uid)", "\"ns\":\"\(ns)\""]
    if let exp {
        fields.append("\"exp\":\(exp)")
    }
    let payload = "{\(fields.joined(separator: ","))}"
    return "eyJhbGciOiJIUzI1NiJ9.\(base64URLEncode(Data(payload.utf8))).c2ln"
}

// MARK: - Error capture

/// Runs `body` and returns the error it threw, or `nil` when it succeeded.
func capturedError<T>(_ body: () async throws -> T) async -> (any Error)? {
    do {
        _ = try await body()
        return nil
    } catch {
        return error
    }
}

// MARK: - Scripted HTTP performer

/// Records every request and answers from a FIFO of stubbed responses
/// (falling back to a configurable default when the queue is empty).
actor RecordingPerformer: HTTPPerforming {
    struct Stub: Sendable {
        var status: Int = 200
        var body: Data = Data("{}".utf8)
        var headers: [String: String] = [:]
    }

    private(set) var requests: [URLRequest] = []
    private var queue: [Stub] = []
    private var fallback = Stub()
    private var delayNanoseconds: UInt64 = 0
    private var transportError: (any Error & Sendable)?

    func enqueue(status: Int = 200, json: String = "{}", headers: [String: String] = [:]) {
        queue.append(Stub(status: status, body: Data(json.utf8), headers: headers))
    }

    /// Makes every subsequent request fail at the transport level (URLError),
    /// as `HTTPPerforming` implementations do for unreachable hosts.
    func setError(_ error: any Error & Sendable) {
        transportError = error
    }

    func setFallback(status: Int, json: String) {
        fallback = Stub(status: status, body: Data(json.utf8))
    }

    /// Delay before answering — lets concurrent callers pile up on one
    /// in-flight exchange.
    func setDelay(nanoseconds: UInt64) {
        delayNanoseconds = nanoseconds
    }

    func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        if let transportError {
            throw transportError
        }
        if delayNanoseconds > 0 {
            try await Task.sleep(nanoseconds: delayNanoseconds)
        }
        let stub = queue.isEmpty ? fallback : queue.removeFirst()
        guard let url = request.url,
              let response = HTTPURLResponse(
                  url: url,
                  statusCode: stub.status,
                  httpVersion: "HTTP/1.1",
                  headerFields: stub.headers
              ) else {
            throw URLError(.badURL)
        }
        return (stub.body, response)
    }
}

// MARK: - Wiring

let testHubURLString = "https://hub.test"
let testEpochSeconds = 1_700_000_000
let testNow = Date(timeIntervalSince1970: TimeInterval(testEpochSeconds))

struct Harness {
    let baseURL: URL
    let performer: RecordingPerformer
    let store: InMemoryCredentialStore
    let auth: AuthManager
    let client: APIClient
}

/// Builds the full client stack against a `RecordingPerformer`.
/// `jwt` (when given) is persisted in the credential record, which is how
/// `AuthManager` picks up an initial token.
func makeHarness(
    paired: Bool = true,
    accessToken: String = "access-token",
    jwt: String? = nil,
    now: Date = testNow
) throws -> Harness {
    let baseURL = try #require(URL(string: testHubURLString))
    let performer = RecordingPerformer()
    let store = InMemoryCredentialStore()
    if paired {
        try store.store(HubCredentials(hubUrl: testHubURLString, accessToken: accessToken, jwt: jwt))
    }
    let auth = AuthManager(baseURL: baseURL, credentialStore: store, performer: performer, now: { now })
    let client = APIClient(baseURL: baseURL, authManager: auth, performer: performer)
    return Harness(baseURL: baseURL, performer: performer, store: store, auth: auth, client: client)
}

/// A JWT that will not expire during a test.
func freshJWT(ns: String = "default") -> String {
    makeJWT(ns: ns, exp: testEpochSeconds + 4 * 3600)
}

func authResponseJSON(token: String) -> String {
    "{\"token\":\"\(token)\",\"user\":{\"id\":1}}"
}
