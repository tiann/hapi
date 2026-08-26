import Foundation
import HapiProtocol

/// Device push registration (`docs/api/native-companion-contract.md`, iOS
/// extension): the APNs token is registered with **every** paired hub — each
/// hub pushes independently for its own namespace — and unregistered from a
/// hub on sign-out while its JWT still works. The hub upserts on
/// `(namespace, deviceId, platform)`, so `deviceId` must be stable across
/// re-registrations of the same install.
extension APIClient {
    /// `POST /api/devices/register` (upsert).
    ///
    /// iOS extends the FCM body with `platform: "ios"` (the hub routes those
    /// tokens through APNs instead of FCM) and the per-install end-to-end
    /// `pushKey` (base64 of 32 random bytes, see ``PushDeviceKey``) the hub
    /// uses to encrypt every ``PushEnvelope``.
    public func registerDevice(
        token: String,
        deviceId: String,
        pushKey: String,
        platform: String = "ios"
    ) async throws {
        struct DeviceRegisterRequest: Encodable {
            let token: String
            let platform: String
            let deviceId: String
            let pushKey: String
        }
        try await requestVoid(
            .post,
            "/api/devices/register",
            body: DeviceRegisterRequest(
                token: token,
                platform: platform,
                deviceId: deviceId,
                pushKey: pushKey
            )
        )
    }

    /// `DELETE /api/devices/register` — call on unpair while the JWT is
    /// still valid (best effort; a leaked registration is pruned hub-side
    /// once the push service reports the token dead).
    public func unregisterDevice(token: String) async throws {
        struct DeviceUnregisterRequest: Encodable {
            let token: String
        }
        try await requestVoid(
            .delete,
            "/api/devices/register",
            body: DeviceUnregisterRequest(token: token)
        )
    }
}
