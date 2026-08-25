import Foundation

/// `type` of a push (`docs/api/native-companion-contract.md`). Unknown wire
/// values map to a nil ``PushPayload/type`` — the message still renders from
/// `title`/`body` (forward compatibility), just without type-specific actions.
public enum PushType: String, Sendable {
    case ready
    case permissionRequest = "permission-request"
    case taskNotification = "task-notification"
}

/// `severity` — visual urgency accent (`hub/src/fcm/fcmService.ts`).
public enum PushSeverity: String, Sendable {
    case info
    case success
    case warning
    case error
}

/// Parsed `notifySummary` (JSON string, only on `ready`): the agent's
/// trailing `AGENT_NOTIFY_SUMMARY {...}` line, pre-truncated by the hub.
/// All fields optional — the shape is agent-authored.
public struct PushNotifySummary: Equatable, Sendable {
    public var version: Int?
    public var summary: String?
    public var action: String?
    public var status: String?
    public var agent: String?
    public var project: String?

    public init(
        version: Int? = nil,
        summary: String? = nil,
        action: String? = nil,
        status: String? = nil,
        agent: String? = nil,
        project: String? = nil
    ) {
        self.version = version
        self.summary = summary
        self.action = action
        self.status = status
        self.agent = agent
        self.project = project
    }
}

/// One decoded push message from a hub — the iOS mirror of the Android
/// `PushPayload` (`android/core/data/.../push/PushPayload.kt`). The wire
/// contract is the FCM data payload of `docs/api/native-companion-contract.md`;
/// on iOS the same JSON object travels end-to-end encrypted inside
/// ``PushEnvelope`` and every value arrives as a string.
///
/// Parsing is deliberately tolerant: only `sessionId` is required (it anchors
/// coalescing and tap-through navigation). Unknown `type`, `severity`, or
/// `contractVersion` values never drop the message — it degrades to a plain
/// title/body notification.
public struct PushPayload: Equatable, Sendable {
    /// Decoded type, or nil when ``rawType`` is unknown to this client.
    public var type: PushType?
    /// The wire `type` string as received (diagnostics, category fallback).
    public var rawType: String
    public var sessionId: String
    public var sessionName: String?
    /// Hub-relative deep-link path, e.g. `/sessions/{id}` (informational).
    public var url: String?
    public var title: String?
    public var body: String?
    /// Permission requests only: the id for approve/deny.
    public var requestId: String?
    public var severity: PushSeverity?
    public var contractVersion: String?
    public var notifySummary: PushNotifySummary?

    /// The contract version this client implements.
    public static let contractVersion = "1"

    /// False when the hub stamped a `contractVersion` this client does not
    /// know. Per the contract's versioning rule, breaking changes bump the
    /// version — so an unknown version renders title/body only (no actions
    /// whose semantics may have changed).
    public var isKnownContractVersion: Bool {
        contractVersion == nil || contractVersion == Self.contractVersion
    }

    /// Whether type-specific affordances (Allow/Deny, Reply) may be attached.
    /// Requires a known contract version, a known type, and — for permission
    /// requests — a `requestId` to act on.
    public var supportsActions: Bool {
        guard isKnownContractVersion else { return false }
        switch type {
        case .permissionRequest: return requestId != nil
        case .ready, .taskNotification: return true
        case nil: return false
        }
    }

    /// `UNNotificationCategory` identifier (the contract type string) when
    /// actions apply, nil for a plain tap-to-open notification. The app
    /// registers categories under exactly these identifiers and the
    /// Notification Service Extension stamps the same value.
    public var categoryIdentifier: String? {
        supportsActions ? rawType : nil
    }

    /// Title to render; falls back to the session name, then a constant.
    public var displayTitle: String {
        if let title, !title.isPushBlank { return title }
        if let sessionName, !sessionName.isPushBlank { return sessionName }
        return "HAPI"
    }

    /// Body to render. For `ready` pushes carrying a parsed `notifySummary`,
    /// the summary (plus a `-> action` second line, when distinct) wins over
    /// the hub-composed `body` — Android parity.
    public var displayBody: String {
        if type == .ready, let summary = notifySummary?.summary, !summary.isPushBlank {
            if let action = notifySummary?.action, !action.isPushBlank, action != summary {
                return "\(summary)\n-> \(action)"
            }
            return summary
        }
        return body ?? ""
    }

    public init(
        type: PushType?,
        rawType: String,
        sessionId: String,
        sessionName: String? = nil,
        url: String? = nil,
        title: String? = nil,
        body: String? = nil,
        requestId: String? = nil,
        severity: PushSeverity? = nil,
        contractVersion: String? = nil,
        notifySummary: PushNotifySummary? = nil
    ) {
        self.type = type
        self.rawType = rawType
        self.sessionId = sessionId
        self.sessionName = sessionName
        self.url = url
        self.title = title
        self.body = body
        self.requestId = requestId
        self.severity = severity
        self.contractVersion = contractVersion
        self.notifySummary = notifySummary
    }

    // MARK: - Parsing

    /// Decodes a `[String: String]` field map — the decrypted-and-flattened
    /// form the Notification Service Extension stores into `userInfo` (and
    /// the exact shape of the Android `RemoteMessage.data` map). Returns nil
    /// only when `sessionId` is missing/blank — without it neither coalescing
    /// nor tap-through can work, and the contract guarantees it.
    public static func parse(dictionary data: [String: String]) -> PushPayload? {
        guard let sessionId = nonBlank(data["sessionId"]) else { return nil }
        let rawType = data["type"] ?? ""
        return PushPayload(
            type: PushType(rawValue: rawType),
            rawType: rawType,
            sessionId: sessionId,
            sessionName: nonBlank(data["sessionName"]),
            url: nonBlank(data["url"]),
            title: data["title"],
            body: data["body"],
            requestId: nonBlank(data["requestId"]),
            severity: data["severity"].flatMap(PushSeverity.init(rawValue:)),
            contractVersion: nonBlank(data["contractVersion"]),
            notifySummary: data["notifySummary"].flatMap(parseNotifySummary)
        )
    }

    /// Decodes decrypted ``PushEnvelope`` plaintext: a JSON object whose
    /// values are strings per the FCM data contract. Non-string scalars from
    /// a future hub are tolerated by stringifying; nested values and a
    /// non-object root are rejected the same as a missing `sessionId`.
    public static func parse(plaintext: Data) -> PushPayload? {
        guard let object = try? JSONSerialization.jsonObject(with: plaintext),
              let fields = object as? [String: Any] else {
            return nil
        }
        var map: [String: String] = [:]
        for (key, value) in fields {
            switch value {
            case let string as String:
                map[key] = string
            case let number as NSNumber:
                map[key] = number.stringValue
            default:
                continue // nested/null values carry no contract meaning here
            }
        }
        return parse(dictionary: map)
    }

    /// Malformed JSON → nil (the hub-composed `body` remains the fallback).
    private static func parseNotifySummary(_ raw: String) -> PushNotifySummary? {
        guard let object = try? JSONSerialization.jsonObject(with: Data(raw.utf8)),
              let fields = object as? [String: Any] else {
            return nil
        }
        func string(_ key: String) -> String? { fields[key] as? String }
        return PushNotifySummary(
            version: (fields["version"] as? NSNumber)?.intValue,
            summary: string("summary"),
            action: string("action"),
            status: string("status"),
            agent: string("agent"),
            project: string("project")
        )
    }

    /// Android-parity blankness: whitespace-only counts as absent, but the
    /// value is returned untrimmed.
    private static func nonBlank(_ value: String?) -> String? {
        guard let value, !value.isPushBlank else { return nil }
        return value
    }
}

extension String {
    /// Kotlin `isBlank()` equivalent for the parity checks above.
    fileprivate var isPushBlank: Bool {
        trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}
