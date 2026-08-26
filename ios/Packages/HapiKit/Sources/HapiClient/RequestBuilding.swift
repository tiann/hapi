import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking  // URLSession types live here on Linux
#endif

/// URL assembly shared by `APIClient` and `AuthManager`.
///
/// Percent-encoding is done by hand with the RFC 3986 unreserved set (the
/// strictest choice) so that path components and query values match what the
/// web client produces via `encodeURIComponent`/`URLSearchParams` — notably
/// `+` is encoded as `%2B`, which `URLComponents.queryItems` would leave
/// literal (and the hub would decode as a space).
enum HubRequestURL {
    /// RFC 3986 unreserved characters — everything else is percent-encoded.
    static let unreserved = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
    )

    /// Builds `origin(baseURL) + path + query`. `path` must be an absolute,
    /// already-percent-encoded path (compose dynamic segments with
    /// ``encodePathComponent(_:)``); any path on `baseURL` itself is replaced,
    /// matching the web client's `new URL(path, baseUrl)` for absolute paths.
    static func make(baseURL: URL, path: String, query: [URLQueryItem]) throws -> URL {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: true) else {
            throw URLError(.badURL)
        }
        components.percentEncodedPath = path
        components.fragment = nil
        components.percentEncodedQuery = query.isEmpty ? nil : encodeQuery(query)
        guard let url = components.url else {
            throw URLError(.badURL)
        }
        return url
    }

    /// Joins items in the given order as `name=value`, both strictly encoded.
    static func encodeQuery(_ items: [URLQueryItem]) -> String {
        items.map { item in
            let name = encodeComponent(item.name)
            guard let value = item.value else { return name }
            return "\(name)=\(encodeComponent(value))"
        }
        .joined(separator: "&")
    }

    static func encodeComponent(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: unreserved) ?? value
    }
}

/// Percent-encodes one path segment (the `encodeURIComponent` equivalent used
/// for `:id`-style params throughout the endpoint layer).
func encodePathComponent(_ value: String) -> String {
    HubRequestURL.encodeComponent(value)
}
