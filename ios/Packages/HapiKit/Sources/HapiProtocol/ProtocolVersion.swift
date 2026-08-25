import Foundation

/// The hub protocol generation this client understands.
///
/// Wire models live under `Models/`, mode/flavor catalogs under `Catalog/`,
/// and the session-patch rules under `Patch/`. This anchor predates them
/// (M0) and stays the single place the supported generation is declared.
public struct ProtocolVersion: Sendable {
    /// Highest protocol generation supported by this build.
    public static let supported = 1
}
