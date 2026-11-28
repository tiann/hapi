import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// A Cloudflare Access application token obtained through the user's Access
/// login. It is sent only to the HTTPS origin for which it was entered.
public struct CloudflareAccess: Sendable {
    static let header = "CF-Access-Token"
    private let origin: String
    let token: String

    public init?(hubURL: URL, token: String) {
        guard let origin = HubURLNormalization.normalize(hubURL.absoluteString),
              origin.hasPrefix("https://") else { return nil }
        let token = token.trimmingCharacters(in: .whitespacesAndNewlines)
        let parts = token.split(separator: ".", omittingEmptySubsequences: false)
        let base64URL = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
        guard parts.count == 3,
              parts.allSatisfy({ !$0.isEmpty && $0.unicodeScalars.allSatisfy(base64URL.contains) }) else {
            return nil
        }
        self.origin = origin
        self.token = token
    }

    func authorize(_ request: URLRequest) -> URLRequest {
        guard let url = request.url,
              HubURLNormalization.normalize(url.absoluteString) == origin else { return request }
        var authorized = request
        authorized.setValue(token, forHTTPHeaderField: Self.header)
        return authorized
    }

    static func isSignInResponse(_ response: HTTPURLResponse) -> Bool {
        if isSignInURL(response.url) { return true }
        guard (300..<400).contains(response.statusCode),
              let location = response.value(forHTTPHeaderField: "Location") else { return false }
        return isSignInURL(URL(string: location, relativeTo: response.url)?.absoluteURL)
    }

    static func redirectedRequest(from original: URLRequest?, to request: URLRequest) -> URLRequest? {
        if isSignInURL(request.url) { return nil }
        guard let original, let token = original.value(forHTTPHeaderField: header) else { return request }
        guard let origin = original.url, let destination = request.url,
              let access = CloudflareAccess(hubURL: origin, token: token),
              HubURLNormalization.normalize(destination.absoluteString) == access.origin else { return nil }
        return access.authorize(request)
    }

    private static func isSignInURL(_ url: URL?) -> Bool {
        guard let url, url.scheme?.lowercased() == "https",
              let host = url.host?.lowercased(), host.hasSuffix(".cloudflareaccess.com") else { return false }
        return url.path == "/cdn-cgi/access/login" || url.path.hasPrefix("/cdn-cgi/access/login/")
    }
}

enum CloudflareAccessError: Error {
    case signInRequired
}

class CloudflareAccessRedirectDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping @Sendable (URLRequest?) -> Void
    ) {
        completionHandler(CloudflareAccess.redirectedRequest(from: task.originalRequest, to: request))
    }
}
