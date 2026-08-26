import Foundation

/// Owner gate for the usage/storage settings entries: peeks the (unverified)
/// `ns` claim of the hub JWT — the web twin is
/// `getNamespaceFromToken(token) === 'default'` (`SettingsNav.tsx`), the
/// Android twin `isOwnerNamespace` (`feature/settings/SettingsViewModel.kt`).
///
/// Fails closed: no JWT / undecodable / missing claim all hide the owner-only
/// rows; the endpoints' own 403 stays the real enforcement.
public enum OwnerGate {
    /// Namespace whose JWT belongs to the hub owner (usage/storage visible).
    public static let ownerNamespace = "default"

    public static func isOwnerNamespace(jwt: String?) -> Bool {
        guard let jwt else { return false }
        return JWT.claims(from: jwt)?.ns == ownerNamespace
    }
}
