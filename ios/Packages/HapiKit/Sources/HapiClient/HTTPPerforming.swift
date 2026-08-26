import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking  // URLSession types live here on Linux
#endif

/// Seam between the client stack and the actual HTTP transport.
///
/// `APIClient` and `AuthManager` speak only to this protocol, so tests inject
/// a recording/scripted performer instead of resorting to `URLProtocol`
/// tricks. The production implementation wraps `URLSession`.
public protocol HTTPPerforming: Sendable {
    /// Executes one HTTP exchange. Implementations must not throw on non-2xx
    /// statuses — status handling (401 refresh, `APIError`) belongs to the
    /// caller. Throw only for transport-level failures (`URLError`).
    func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

/// Production `HTTPPerforming` backed by `URLSession`.
public struct URLSessionHTTPPerformer: HTTPPerforming {
    public let session: URLSession

    public init(session: URLSession) {
        self.session = session
    }

    /// Shared instance used by default across the client stack, so every
    /// consumer benefits from one connection pool and one URL cache.
    public static let shared = URLSessionHTTPPerformer(session: makeDefaultSession())

    /// `URLSession` configured for the hub protocol.
    ///
    /// The 256 MB disk cache exists chiefly for generated images: the hub
    /// serves them with `ETag` + `Cache-Control: private, max-age=31536000,
    /// immutable`, so `URLCache` answers repeats locally (and revalidates via
    /// `If-None-Match`/304 without the hub's CLI round-trip). Streaming gzip
    /// decompression of JSON responses is transparent in `URLSession`.
    public static func makeDefaultSession() -> URLSession {
        let configuration = URLSessionConfiguration.default
        #if canImport(FoundationNetworking)
        // corelibs-foundation only ships the legacy `diskPath:` initializer.
        configuration.urlCache = URLCache(
            memoryCapacity: 32 * 1024 * 1024,
            diskCapacity: 256 * 1024 * 1024,
            diskPath: nil
        )
        #else
        configuration.urlCache = URLCache(
            memoryCapacity: 32 * 1024 * 1024,
            diskCapacity: 256 * 1024 * 1024,
            directory: nil
        )
        #endif
        configuration.requestCachePolicy = .useProtocolCachePolicy
        return URLSession(configuration: configuration)
    }

    public func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        return (data, http)
    }
}

/// JSON coders shared by the whole transport layer so wire behavior is
/// uniform (and request bodies are byte-stable for tests).
public enum HapiJSON {
    /// Wire fields are camelCase and dates are epoch-ms integers, so the
    /// default strategies are exactly right.
    public static let decoder = JSONDecoder()

    /// `sortedKeys` makes encoded bodies deterministic;
    /// `withoutEscapingSlashes` keeps embedded paths readable.
    public static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return encoder
    }()
}
