import Foundation

/// Parsed companion pairing link.
///
/// The hub prints (and renders as QR codes) two pairing links — see
/// `hub/src/startHub.ts` and `docs/api/client-contract/auth.md`:
///
/// 1. The canonical companion deeplink
///    `hapicompanion://bind?hub=<url>&code=<accessToken>`, and
/// 2. the web direct-access URL `https://<web>/?hub=<url>&token=<accessToken>`
///    (same values, different scheme and param name). A robust scanner accepts
///    both, so pointing the camera at the "wrong" QR still pairs.
///
/// Both queries are built with `URLSearchParams`, i.e.
/// `application/x-www-form-urlencoded`: `%xx` escapes plus `+` for space.
/// `code`/`token` is the raw CLI access token, possibly suffixed with
/// `:namespace`, so it round-trips percent-encoded (`%3A`).
///
/// Semantics are kept in lockstep with the Android port
/// (`android/core/protocol/.../pairing/BindLink.kt`): scheme and host match
/// case-insensitively, the first occurrence wins for duplicate params, blank
/// values are rejected, the `hub` value must itself be an http(s) URL, and any
/// malformed input (including invalid percent escapes) parses to `nil`.
///
/// Lives in `HapiProtocol` (pure Foundation) so it is unit-testable without
/// the app target; the app's `onOpenURL` handler and QR scanner both feed
/// their strings through ``parse(_:)``.
public struct BindLink: Equatable, Sendable {
    /// The hub base URL exactly as carried by the link (decoded, not yet
    /// normalized — hub-URL normalization is the client layer's job).
    public let hubUrl: String
    /// The pairing access token, passed verbatim to `POST /api/auth`.
    public let accessToken: String

    public init(hubUrl: String, accessToken: String) {
        self.hubUrl = hubUrl
        self.accessToken = accessToken
    }

    /// Scheme of the canonical companion deeplink.
    public static let scheme = "hapicompanion"
    /// Host of the canonical companion deeplink.
    public static let host = "bind"

    /// Parses `raw` into a ``BindLink``.
    ///
    /// Accepts the companion deeplink form (`hapicompanion://bind?hub=&code=`)
    /// and the web direct-access form (`http(s)://<web>/...?hub=&token=`).
    /// Returns `nil` on any malformed input: unparseable URL, wrong scheme or
    /// host, missing/blank `hub` and `code`/`token` parameters, invalid
    /// percent escapes, or a `hub` value that is not an http(s) URL.
    public static func parse(_ raw: String) -> BindLink? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              let components = URLComponents(string: trimmed),
              let scheme = components.scheme?.lowercased() else {
            return nil
        }
        switch scheme {
        case Self.scheme:
            return parseCompanionDeeplink(components)
        case "http", "https":
            return parseWebDirectAccessURL(components)
        default:
            return nil
        }
    }

    // MARK: - Forms

    /// `hapicompanion://bind?hub=<url>&code=<accessToken>` — the canonical
    /// deeplink; the only form that arrives via the registered URL scheme.
    private static func parseCompanionDeeplink(_ components: URLComponents) -> BindLink? {
        guard let host = components.host?.lowercased(), host == Self.host else {
            return nil
        }
        guard let params = formParameters(of: components),
              let hub = params["hub"], !isBlank(hub),
              let code = params["code"], !isBlank(code),
              isHTTPURL(hub) else {
            return nil
        }
        return BindLink(hubUrl: hub, accessToken: code)
    }

    /// `http(s)://<web host>/...?hub=<url>&token=<accessToken>` — the web
    /// direct-access QR (`${officialWebUrl}/?hub=…&token=…`). The web host and
    /// path are not pinned: self-hosted deployments serve the app anywhere.
    private static func parseWebDirectAccessURL(_ components: URLComponents) -> BindLink? {
        guard let host = components.host, !host.isEmpty else {
            return nil
        }
        guard let params = formParameters(of: components),
              let hub = params["hub"], !isBlank(hub),
              let token = params["token"], !isBlank(token),
              isHTTPURL(hub) else {
            return nil
        }
        return BindLink(hubUrl: hub, accessToken: token)
    }

    // MARK: - Form decoding (URLSearchParams parity)

    /// Decodes the raw query as `application/x-www-form-urlencoded`.
    /// First occurrence wins for duplicate keys. Returns `nil` when the query
    /// is absent or any component carries invalid percent escapes.
    private static func formParameters(of components: URLComponents) -> [String: String]? {
        guard let rawQuery = components.percentEncodedQuery else { return nil }
        var result: [String: String] = [:]
        for pair in rawQuery.split(separator: "&", omittingEmptySubsequences: false) {
            if pair.isEmpty { continue }
            let rawKey: Substring
            let rawValue: Substring
            if let separator = pair.firstIndex(of: "=") {
                rawKey = pair[..<separator]
                rawValue = pair[pair.index(after: separator)...]
            } else {
                rawKey = pair
                rawValue = ""
            }
            guard let key = decodeFormComponent(String(rawKey)),
                  let value = decodeFormComponent(String(rawValue)) else {
                return nil
            }
            if result[key] == nil {
                result[key] = value
            }
        }
        return result
    }

    /// One form-encoded component: `+` means space, then percent-decoding.
    /// (`%2B` still decodes to a literal `+` — the replacement happens on the
    /// still-encoded text.) `removingPercentEncoding` answers `nil` for
    /// invalid escape sequences, matching the Android port's null-on-invalid.
    private static func decodeFormComponent(_ component: String) -> String? {
        component
            .replacingOccurrences(of: "+", with: " ")
            .removingPercentEncoding
    }

    private static func isBlank(_ value: String) -> Bool {
        value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// The `hub` value must be an absolute http(s) URL with a host.
    private static func isHTTPURL(_ value: String) -> Bool {
        guard let components = URLComponents(string: value),
              let scheme = components.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              let host = components.host, !host.isEmpty else {
            return false
        }
        return true
    }
}
