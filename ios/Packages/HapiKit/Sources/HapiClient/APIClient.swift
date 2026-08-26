import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking  // URLSession types live here on Linux
#endif
import HapiProtocol

/// HTTP method of a hub request.
public enum HTTPMethod: String, Sendable {
    case get = "GET"
    case post = "POST"
    case put = "PUT"
    case patch = "PATCH"
    case delete = "DELETE"
}

/// A non-2xx hub response.
///
/// Error bodies are JSON `{error, code?}` (`docs/api/client-contract/errors.md`).
/// `code` carries the stable machine discriminator when present; per the web
/// reference (`parseErrorCode`), a string `error` is used as a pseudo-code
/// fallback — acceptable for logging, not for logic. `body` keeps the raw
/// text for detail views.
public struct APIError: Error, Equatable, Sendable {
    public let status: Int
    public let code: String?
    public let body: String?

    public init(status: Int, code: String? = nil, body: String? = nil) {
        self.status = status
        self.code = code
        self.body = body
    }

    /// Parses a `{error, code?}` body. Non-JSON bodies yield `code == nil`.
    public init(status: Int, responseBody: Data) {
        self.status = status
        self.body = responseBody.isEmpty ? nil : String(data: responseBody, encoding: .utf8)
        var parsedCode: String?
        if let value = try? HapiJSON.decoder.decode(JSONValue.self, from: responseBody),
           case .object(let object) = value {
            if case .string(let code)? = object["code"] {
                parsedCode = code
            } else if case .string(let error)? = object["error"] {
                parsedCode = error
            }
        }
        self.code = parsedCode
    }
}

extension APIError: LocalizedError {
    public var errorDescription: String? {
        var description = "HTTP \(status)"
        if let code {
            description += " (\(code))"
        }
        return description
    }
}

/// Typed REST client for one hub.
///
/// Stateless by design: the JWT lives in ``AuthManager`` (which single-flights
/// refreshes), so this class is a `Sendable` bundle of immutable wiring and
/// requests may run concurrently. Endpoint methods live in extensions under
/// `Endpoints/`; feature packages (git/files, scratchlist, voice, usage)
/// add theirs the same way.
///
/// Every authenticated request sends `Authorization: Bearer <JWT>`; on a 401
/// it asks the auth manager for a refreshed token and retries exactly once —
/// a second 401 marks authentication failed (re-pair needed) and surfaces an
/// ``APIError``.
public final class APIClient: Sendable {
    /// Origin of the active hub (from ``HubRegistry``).
    public let baseURL: URL
    public let authManager: AuthManager
    private let performer: any HTTPPerforming

    public init(
        baseURL: URL,
        authManager: AuthManager,
        performer: any HTTPPerforming = URLSessionHTTPPerformer.shared
    ) {
        self.baseURL = baseURL
        self.authManager = authManager
        self.performer = performer
    }

    // MARK: - Typed request surface

    /// GET-style JSON request without a body.
    public func request<T: Decodable>(
        _ method: HTTPMethod,
        _ path: String,
        query: [URLQueryItem] = [],
        authenticated: Bool = true
    ) async throws -> T {
        let (data, _) = try await send(method, path: path, query: query, authenticated: authenticated)
        return try HapiJSON.decoder.decode(T.self, from: data)
    }

    /// JSON request with a JSON body.
    public func request<T: Decodable, Body: Encodable>(
        _ method: HTTPMethod,
        _ path: String,
        query: [URLQueryItem] = [],
        body: Body,
        authenticated: Bool = true
    ) async throws -> T {
        let bodyData = try HapiJSON.encoder.encode(body)
        let (data, _) = try await send(
            method,
            path: path,
            query: query,
            bodyData: bodyData,
            authenticated: authenticated
        )
        return try HapiJSON.decoder.decode(T.self, from: data)
    }

    /// JSON request with a pre-encoded body (multipart, etc.).
    public func request<T: Decodable>(
        _ method: HTTPMethod,
        _ path: String,
        query: [URLQueryItem] = [],
        rawBody: Data,
        contentType: String
    ) async throws -> T {
        let (data, _) = try await send(
            method,
            path: path,
            query: query,
            bodyData: rawBody,
            contentType: contentType
        )
        return try HapiJSON.decoder.decode(T.self, from: data)
    }

    /// Request whose response body is ignored (`{ok: true}` endpoints).
    public func requestVoid(
        _ method: HTTPMethod,
        _ path: String,
        query: [URLQueryItem] = []
    ) async throws {
        _ = try await send(method, path: path, query: query)
    }

    /// Body-carrying request whose response body is ignored.
    public func requestVoid<Body: Encodable>(
        _ method: HTTPMethod,
        _ path: String,
        query: [URLQueryItem] = [],
        body: Body
    ) async throws {
        let bodyData = try HapiJSON.encoder.encode(body)
        _ = try await send(method, path: path, query: query, bodyData: bodyData)
    }

    /// Raw-bytes GET (generated images, scratchlist attachments). Responses
    /// flow through the session's `URLCache`, so the hub's
    /// `ETag`/`immutable` headers make repeats free.
    public func requestBytes(
        _ path: String,
        query: [URLQueryItem] = []
    ) async throws -> (data: Data, response: HTTPURLResponse) {
        try await send(.get, path: path, query: query)
    }

    // MARK: - Core

    /// One authenticated exchange with the 401 → refresh → retry-once rule
    /// (`docs/api/client-contract/auth.md`). Throws ``APIError`` for non-2xx
    /// statuses and propagates ``AuthError`` when re-auth is impossible.
    func send(
        _ method: HTTPMethod,
        path: String,
        query: [URLQueryItem] = [],
        bodyData: Data? = nil,
        contentType: String? = "application/json",
        authenticated: Bool = true
    ) async throws -> (Data, HTTPURLResponse) {
        let url = try HubRequestURL.make(baseURL: baseURL, path: path, query: query)
        var request = URLRequest(url: url)
        request.httpMethod = method.rawValue
        if let bodyData {
            request.httpBody = bodyData
            if let contentType {
                request.setValue(contentType, forHTTPHeaderField: "Content-Type")
            }
        }

        guard authenticated else {
            let (data, response) = try await performer.perform(request)
            try Self.validate(status: response.statusCode, data: data)
            return (data, response)
        }

        let token = try await authManager.validToken()
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        var (data, response) = try await performer.perform(request)

        if response.statusCode == 401 {
            // Routine JWT expiry: silently re-exchange the stored access
            // token and retry exactly once.
            let refreshed = try await authManager.refreshAfterUnauthorized(failedToken: token)
            request.setValue("Bearer \(refreshed)", forHTTPHeaderField: "Authorization")
            (data, response) = try await performer.perform(request)
            if response.statusCode == 401 {
                // A fresh JWT was refused — the credentials are dead.
                await authManager.markAuthenticationFailed()
                throw APIError(status: 401, responseBody: data)
            }
        }

        try Self.validate(status: response.statusCode, data: data)
        return (data, response)
    }

    private static func validate(status: Int, data: Data) throws {
        guard (200..<300).contains(status) else {
            throw APIError(status: status, responseBody: data)
        }
    }
}
