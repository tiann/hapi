import Foundation
import HapiProtocol

/// Version anchor for the transport layer.
///
/// As of M1b the target carries `APIClient` + typed endpoints, `AuthManager`
/// (single-flight JWT refresh), the Keychain credential store, `HubRegistry`,
/// and the multipart builder; SSEClient and the stores arrive in M1c+.
public enum HapiClientVersion {
    /// Version of the HapiKit client scaffold.
    public static let current = "0.1.0"

    /// Highest hub protocol generation this client speaks.
    public static let protocolVersion = ProtocolVersion.supported
}
