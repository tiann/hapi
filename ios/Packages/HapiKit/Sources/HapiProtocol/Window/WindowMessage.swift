import Foundation

/// Client-side send state of an optimistic user message. The web reference
/// extends the wire `DecryptedMessage` with `status?: MessageStatus`
/// (`web/src/types/api.ts`); the wire never carries it — servers echo rows
/// without a status and the client re-attaches it during merge.
public enum MessageStatus: String, Codable, Sendable {
    case queued
    case sending
    case sent
    case failed
    case indeterminate
}

/// Wire tri-state of `invokedAt` (`pagination.md` "Queued semantics"):
/// an absent key means already-invoked (pre-V8 hubs omit the field), an
/// explicit `null` means still queued, a number is the invocation time.
/// The strict-null queued check and the fixture projection both need the
/// three states kept apart, which the collapsed `DecryptedMessage.invokedAt`
/// (`Int?`) cannot do.
public enum InvokedAtField: Equatable, Sendable {
    case absent
    case null
    case number(Int)

    /// Collapsed JS view (`invokedAt ?? …` semantics): the number, or `nil`
    /// for both `null` and absent.
    public var numberValue: Int? {
        if case .number(let value) = self { return value }
        return nil
    }

    /// JS `invokedAt !== undefined` — the wire carried the key.
    public var isPresent: Bool { self != .absent }
}

/// One row of the message window: the wire `DecryptedMessage` fields plus the
/// client-side ``status``. Mirrors the web's `DecryptedMessage & {status?}`.
///
/// Deliberately a **class**: `applyLatestResponse`'s request-baseline
/// comparison is by reference (web `!==`, Android object identity), so rows
/// need identity, and transitions must only create new instances for rows
/// they actually change — which every function in this package does.
/// ``Equatable`` is therefore identity (`===`) as well: two deep-equal rows
/// are different instances on purpose (that difference is what classifies a
/// row as "changed since the request left" during a reset replace).
///
/// Instances are immutable (`let` storage), so the class is safely `Sendable`.
public final class WindowMessage: Sendable, Equatable {
    // MARK: Wire fields (`DecryptedMessageSchema`, with tri-state invokedAt)

    /// Server uuid. Optimistic rows use the client `localId` until echoed.
    public let id: String
    /// Per-session insert counter; `nil` on optimistic rows.
    public let seq: Int?
    /// Client-generated id for optimistic reconciliation.
    public let localId: String?
    /// Role-wrapped envelope, kept wire-verbatim.
    public let content: JSONValue
    /// Hub receive time (epoch ms).
    public let createdAt: Int
    /// Invocation time, kept tri-state (see ``InvokedAtField``).
    public let invokedAt: InvokedAtField
    /// Future-scheduled send time (epoch ms), when set.
    public let scheduledAt: Int?

    // MARK: Client-side

    public let status: MessageStatus?

    public init(
        id: String,
        seq: Int? = nil,
        localId: String? = nil,
        content: JSONValue = .null,
        createdAt: Int,
        invokedAt: InvokedAtField = .absent,
        scheduledAt: Int? = nil,
        status: MessageStatus? = nil
    ) {
        self.id = id
        self.seq = seq
        self.localId = localId
        self.content = content
        self.createdAt = createdAt
        self.invokedAt = invokedAt
        self.scheduledAt = scheduledAt
        self.status = status
    }

    /// Wrap a wire row. `DecryptedMessage` collapses the invokedAt tri-state
    /// to `Int?`; `nil` maps to an **explicit null** here because V8+ hubs
    /// always send the key (see the caveat on `DecryptedMessage.invokedAt` —
    /// if pre-V8 hub support is ever needed, the wire model must learn the
    /// tri-state and this initializer picks it up).
    public convenience init(wire: DecryptedMessage, status: MessageStatus? = nil) {
        self.init(
            id: wire.id,
            seq: wire.seq,
            localId: wire.localId,
            content: wire.content,
            createdAt: wire.createdAt,
            invokedAt: wire.invokedAt.map(InvokedAtField.number) ?? .null,
            scheduledAt: wire.scheduledAt,
            status: status ?? (wire.deliveryState == "indeterminate" ? .indeterminate : nil)
        )
    }

    /// Identity equality — see the type comment.
    public static func == (lhs: WindowMessage, rhs: WindowMessage) -> Bool {
        lhs === rhs
    }

    // MARK: Derived

    /// Collapsed invocation time (JS `invokedAt ?? …` operand).
    public var invokedAtNumber: Int? { invokedAt.numberValue }

    /// Position time `invokedAt ?? createdAt` (`pagination.md` "Position key").
    public var positionAt: Int { invokedAt.numberValue ?? createdAt }

    /// JS `message.invokedAt === null`.
    public var hasExplicitNullInvokedAt: Bool { invokedAt == .null }

    /// A row is optimistic iff it has a localId and `id === localId`
    /// (web `optimisticMessage`).
    public var isOptimistic: Bool {
        localId != nil && id == localId
    }

    /// Web `isUserMessage` (`web/src/lib/messages.ts`): the content envelope
    /// is an object whose `role` is the string `'user'`.
    public var isUserMessage: Bool {
        content.objectValue?["role"]?.stringValue == "user"
    }

    /// Web `isQueuedForInvocation`: a user message whose `invokedAt` is an
    /// explicit `null` and whose send did not fail. Only these rows sit in
    /// the queued bar and survive window trims.
    public var isQueuedForInvocation: Bool {
        isUserMessage && hasExplicitNullInvokedAt && status != .failed
    }

    // MARK: Copies (each returns a NEW instance — identity change is meaningful)

    /// Copy with `invokedAt` stamped to an explicit number.
    public func withInvokedAt(_ invokedAt: Int) -> WindowMessage {
        WindowMessage(
            id: id, seq: seq, localId: localId, content: content,
            createdAt: createdAt, invokedAt: .number(invokedAt),
            scheduledAt: scheduledAt, status: status
        )
    }

    public func withDeliveryState(_ state: String?) -> WindowMessage {
        withStatus(state == "indeterminate" ? .indeterminate : (status ?? .queued))
    }

    /// Copy with the client-side status replaced.
    public func withStatus(_ status: MessageStatus) -> WindowMessage {
        WindowMessage(
            id: id, seq: seq, localId: localId, content: content,
            createdAt: createdAt, invokedAt: invokedAt,
            scheduledAt: scheduledAt, status: status
        )
    }

    /// The chat pipeline's collapsed wire view of this row (feeds
    /// `normalizeDecryptedMessage`).
    public var asDecryptedMessage: DecryptedMessage {
        DecryptedMessage(
            id: id,
            seq: seq,
            localId: localId,
            content: content,
            createdAt: createdAt,
            invokedAt: invokedAt.numberValue,
            scheduledAt: scheduledAt,
            deliveryState: status == .indeterminate ? "indeterminate" : nil
        )
    }
}

// MARK: - Codable (wire object plus an optional `status` key)

/// Serializes as the wire object plus an optional `status` key — the same
/// shape the web persists (and the pagination fixtures use for op inputs).
/// `invokedAt` round-trips the tri-state: key omitted when absent, `null`
/// when explicit null.
extension WindowMessage: Codable {
    private enum CodingKeys: String, CodingKey {
        case id, seq, localId, content, createdAt, invokedAt, scheduledAt, status
    }

    public convenience init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let invokedAt: InvokedAtField
        if container.contains(.invokedAt) {
            if try container.decodeNil(forKey: .invokedAt) {
                invokedAt = .null
            } else {
                invokedAt = .number(try container.decode(Int.self, forKey: .invokedAt))
            }
        } else {
            invokedAt = .absent
        }
        self.init(
            id: try container.decode(String.self, forKey: .id),
            seq: try container.decodeIfPresent(Int.self, forKey: .seq),
            localId: try container.decodeIfPresent(String.self, forKey: .localId),
            content: try container.decodeIfPresent(JSONValue.self, forKey: .content) ?? .null,
            createdAt: try container.decode(Int.self, forKey: .createdAt),
            invokedAt: invokedAt,
            scheduledAt: try container.decodeIfPresent(Int.self, forKey: .scheduledAt),
            // Unknown status strings degrade to nil (Android `fromWire`) —
            // a new client-side state must not break snapshot hydration.
            status: (try container.decodeIfPresent(String.self, forKey: .status))
                .flatMap(MessageStatus.init(rawValue:))
        )
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        // Optional-encoding writes explicit `null`s for seq/localId, matching
        // the wire rows the hub emits.
        try container.encode(seq, forKey: .seq)
        try container.encode(localId, forKey: .localId)
        try container.encode(content, forKey: .content)
        try container.encode(createdAt, forKey: .createdAt)
        switch invokedAt {
        case .absent:
            break
        case .null:
            try container.encodeNil(forKey: .invokedAt)
        case .number(let value):
            try container.encode(value, forKey: .invokedAt)
        }
        try container.encodeIfPresent(scheduledAt, forKey: .scheduledAt)
        try container.encodeIfPresent(status?.rawValue, forKey: .status)
    }
}

// MARK: - Optimistic row construction

/// Builds the optimistic row appended on send, mirroring
/// `createOptimisticMessage` in `web/src/hooks/mutations/useSendMessage.ts`
/// and the contract's "Optimistic sends" lifecycle: `id = localId`,
/// `seq = null`, explicit `invokedAt: null` (so the strict-null queued check
/// matches), content `{role:'user', content:{type:'text', text, attachments?},
/// meta:{deliveryMode}}`.
public func buildOptimisticMessage(
    localId: String,
    text: String,
    createdAt: Int,
    attachments: [AttachmentMetadata]? = nil,
    scheduledAt: Int? = nil,
    deliveryMode: String = "queue",
    status: MessageStatus = .sending
) -> WindowMessage {
    var inner: [String: JSONValue] = [
        "type": .string("text"),
        "text": .string(text),
    ]
    if let attachments {
        inner["attachments"] = .array(attachments.map { attachment in
            var object: [String: JSONValue] = [
                "id": .string(attachment.id),
                "filename": .string(attachment.filename),
                "mimeType": .string(attachment.mimeType),
                "size": .number(Double(attachment.size)),
                "path": .string(attachment.path),
            ]
            if let previewUrl = attachment.previewUrl {
                object["previewUrl"] = .string(previewUrl)
            }
            return .object(object)
        })
    }
    let content: JSONValue = .object([
        "role": .string("user"),
        "content": .object(inner),
        "meta": .object(["deliveryMode": .string(deliveryMode)]),
    ])
    return WindowMessage(
        id: localId,
        seq: nil,
        localId: localId,
        content: content,
        createdAt: createdAt,
        invokedAt: .null,
        scheduledAt: scheduledAt,
        status: status
    )
}
