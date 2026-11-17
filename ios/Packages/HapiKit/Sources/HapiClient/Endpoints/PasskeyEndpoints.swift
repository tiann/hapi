import Foundation
import HapiProtocol

/// Native passkey endpoints (`docs/api/client-contract/auth.md#passkeys-native`).
/// The app always sends `{ "client": "native" }`, so the hub uses the shared
/// RP ID instead of an `Origin` header (natives send none).
extension APIClient {
    /// `POST /api/passkey/register/options` (JWT required).
    public func passkeyRegistrationOptions() async throws -> PasskeyRegistrationOptions {
        try await request(.post, "/api/passkey/register/options", body: PasskeyOptionsRequest())
    }

    /// `POST /api/passkey/register/verify` `{response, name}` (JWT required).
    /// The name is trimmed, omitted when blank, and clamped to the hub's limit.
    public func verifyPasskeyRegistration(_ response: PasskeyRegistrationResponseJSON, name: String?) async throws {
        struct Body: Encodable {
            let response: PasskeyRegistrationResponseJSON
            let name: String?
        }
        let trimmed = name?.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalized = trimmed.flatMap { $0.isEmpty ? nil : Self.clampPasskeyName($0) }
        try await requestVoid(.post, "/api/passkey/register/verify", body: Body(response: response, name: normalized))
    }

    /// `POST /api/passkey/login/options` (unauthenticated). A
    /// `404 {"error":"no_passkeys"}` is mapped to ``PasskeyError/noPasskeys``.
    public func passkeyLoginOptions() async throws -> PasskeyAssertionOptions {
        do {
            return try await request(
                .post,
                "/api/passkey/login/options",
                body: PasskeyOptionsRequest(),
                authenticated: false
            )
        } catch let error as APIError where error.status == 404 && error.code == "no_passkeys" {
            throw PasskeyError.noPasskeys
        }
    }

    /// `POST /api/passkey/login/verify` `{response}` (unauthenticated) →
    /// JWT + passkey session.
    public func verifyPasskeyLogin(_ response: PasskeyAssertionResponseJSON) async throws -> PasskeyLoginResponse {
        struct Body: Encodable {
            let response: PasskeyAssertionResponseJSON
        }
        return try await request(
            .post,
            "/api/passkey/login/verify",
            body: Body(response: response),
            authenticated: false
        )
    }

    /// `GET /api/passkeys` — the caller's namespace, native and web.
    public func listPasskeys() async throws -> [PasskeySummary] {
        let response: PasskeyListResponse = try await request(.get, "/api/passkeys")
        return response.passkeys
    }

    /// `DELETE /api/passkeys/:id` — also revokes that passkey's sessions.
    public func deletePasskey(id: String) async throws {
        try await requestVoid(.delete, "/api/passkeys/\(encodePathComponent(id))")
    }

    /// Full registration: options → RP check → platform sheet → verify.
    /// Throws ``PasskeyError`` (``PasskeyError/canceled`` when dismissed) or
    /// ``APIError``.
    public func registerPasskey(name: String?, using authenticator: any PasskeyAuthenticating) async throws {
        let options = try await passkeyRegistrationOptions()
        let request = try PasskeyRegistrationRequest(options: options, hubURL: baseURL)
        let result = try await authenticator.register(request)
        try await verifyPasskeyRegistration(PasskeyRegistrationResponseJSON(result), name: name)
    }

    /// The hub caps names at 64 UTF-16 code units (zod `max(64)`).
    static func clampPasskeyName(_ name: String) -> String {
        var clamped = name
        while clamped.utf16.count > 64 {
            clamped.removeLast()
        }
        return clamped
    }
}
