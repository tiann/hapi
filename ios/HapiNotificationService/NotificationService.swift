import CryptoKit
import Foundation
import Security
import UserNotifications

/// Notification Service Extension (P3): APNs delivers
/// `{aps: {mutable-content: 1, alert: <generic>}, hapi: {v: 1, e: <envelope>}}`
/// — the real content travels end-to-end encrypted so APNs (and any relay)
/// only ever sees an opaque blob. This extension opens the envelope with the
/// per-install push key from the shared Keychain group, replaces the generic
/// alert with the decrypted title/body, stamps the action category, and
/// stores the decrypted field map into `userInfo` for the app's tap/action
/// handlers.
///
/// Anything undecryptable (missing key, tampered blob, unknown shape) simply
/// delivers the generic alert unchanged — never a dropped notification.
///
/// This target deliberately links **nothing** beyond the SDK: the crypto and
/// parsing below are a small self-contained copy of
/// `ios/Packages/HapiKit/Sources/HapiClient/Push/PushEnvelope.swift` (+ the
/// relevant slice of `PushPayload.swift`), kept in sync by the shared test
/// vector rather than by a link dependency.
final class NotificationService: UNNotificationServiceExtension {
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var bestAttempt: UNMutableNotificationContent?

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        self.contentHandler = contentHandler
        guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
            contentHandler(request.content)
            return
        }
        bestAttempt = content

        if let fields = Self.decryptedFields(from: request.content.userInfo) {
            Self.apply(fields, to: content)
        }
        contentHandler(content)
    }

    /// Out of time: deliver whatever we have (the generic alert when the
    /// decrypt never finished).
    override func serviceExtensionTimeWillExpire() {
        if let contentHandler, let bestAttempt {
            contentHandler(bestAttempt)
        }
    }

    // MARK: - Envelope → field map

    /// `userInfo.hapi.e` → decrypt → flat `[String: String]` of the FCM
    /// data-contract fields. Nil on any failure (fallback: generic alert).
    static func decryptedFields(from userInfo: [AnyHashable: Any]) -> [String: String]? {
        guard let hapi = userInfo["hapi"] as? [String: Any],
              let envelope = hapi["e"] as? String,
              let key = readPushKey(),
              let plaintext = decrypt(envelopeBase64: envelope, key: key),
              let object = try? JSONSerialization.jsonObject(with: plaintext),
              let raw = object as? [String: Any] else {
            return nil
        }
        var fields: [String: String] = [:]
        for (name, value) in raw {
            if let string = value as? String {
                fields[name] = string
            } else if let number = value as? NSNumber {
                fields[name] = number.stringValue
            }
        }
        guard let sessionId = fields["sessionId"], !isBlank(sessionId) else { return nil }
        return fields
    }

    /// Contract slice of `PushPayload` (see the header note): display title,
    /// display body (ready-summary composition), category for actions.
    static func apply(_ fields: [String: String], to content: UNMutableNotificationContent) {
        let type = fields["type"] ?? ""
        let contractVersion = fields["contractVersion"]
        let knownVersion = contractVersion == nil || isBlank(contractVersion!) || contractVersion == "1"

        content.title = firstNonBlank(fields["title"], fields["sessionName"]) ?? "HAPI"
        content.body = displayBody(fields, type: type)
        content.sound = .default

        let supportsActions = knownVersion && (
            (type == "permission-request" && !isBlank(fields["requestId"] ?? ""))
                || type == "ready"
                || type == "task-notification"
        )
        if supportsActions {
            // Category ids are the contract type strings; the app registers
            // Allow/Deny + Reply actions under exactly these identifiers.
            content.categoryIdentifier = type
        }
        // Coalescing (Android `type-<sessionId>` tag): a newer push of the
        // same type for the same session replaces the previous one.
        content.threadIdentifier = "\(type.isEmpty ? "unknown" : type)-\(fields["sessionId"] ?? "")"
        // Decrypted plaintext for the app-side tap/action handlers — key name
        // is `PushCoordinator.decryptedUserInfoKey`.
        var userInfo = content.userInfo
        userInfo["hapiDecrypted"] = fields
        content.userInfo = userInfo
    }

    private static func displayBody(_ fields: [String: String], type: String) -> String {
        if type == "ready",
           let rawSummary = fields["notifySummary"],
           let object = try? JSONSerialization.jsonObject(with: Data(rawSummary.utf8)),
           let summaryFields = object as? [String: Any],
           let summary = summaryFields["summary"] as? String,
           !isBlank(summary) {
            if let action = summaryFields["action"] as? String, !isBlank(action), action != summary {
                return "\(summary)\n-> \(action)"
            }
            return summary
        }
        return fields["body"] ?? ""
    }

    private static func firstNonBlank(_ values: String?...) -> String? {
        for value in values {
            if let value, !isBlank(value) {
                return value
            }
        }
        return nil
    }

    private static func isBlank(_ value: String) -> Bool {
        value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    // MARK: - AES-256-GCM envelope (copy of HapiClient `PushEnvelope`)

    /// Opens `base64(nonce[12] || ciphertext || tag[16])`, AAD ASCII
    /// `hapi-push-v1` — byte-for-byte the construction verified by the
    /// `PushEnvelopeTests` vector in HapiKit.
    static func decrypt(envelopeBase64: String, key: Data) -> Data? {
        let nonceLength = 12
        let tagLength = 16
        guard key.count == 32,
              let envelope = Data(base64Encoded: envelopeBase64),
              envelope.count >= nonceLength + tagLength else {
            return nil
        }
        let nonce = envelope.subdata(in: 0..<nonceLength)
        let ciphertext = envelope.subdata(in: nonceLength..<(envelope.count - tagLength))
        let tag = envelope.subdata(in: (envelope.count - tagLength)..<envelope.count)
        guard let box = try? AES.GCM.SealedBox(
            nonce: AES.GCM.Nonce(data: nonce),
            ciphertext: ciphertext,
            tag: tag
        ) else {
            return nil
        }
        return try? AES.GCM.open(
            box,
            using: SymmetricKey(data: key),
            authenticating: Data("hapi-push-v1".utf8)
        )
    }

    // MARK: - Shared-group Keychain (copy of the app's `PushKeychain` read)

    /// The per-install push key the app stored under service
    /// `run.hapi.companion.push` in the shared access group
    /// `$(AppIdentifierPrefix)run.hapi.companion.push`. No explicit
    /// `kSecAttrAccessGroup`: the read searches every group this extension
    /// can access, which includes the shared one. The item is
    /// `AfterFirstUnlock`, so decryption works on the lock screen (any time
    /// after the first unlock since boot).
    static func readPushKey() -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "run.hapi.companion.push",
            kSecAttrAccount as String: "pushKey",
            kSecUseDataProtectionKeychain as String: true,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess else {
            return nil
        }
        return item as? Data
    }
}
