import Foundation

/// One chat message as returned by `GET /api/sessions/:id/messages` and the
/// `message-received` SSE event.
///
/// Mirrors `DecryptedMessageSchema` (`shared/src/schemas.ts`). `content` is
/// deliberately left as raw ``JSONValue``: it is the role-wrapped envelope
/// whose decode tree (`docs/api/client-contract/messages.md`) is ported in the
/// M2 chat milestones. Decoding a message is total — an absent or `null`
/// `content` degrades to `.null` instead of throwing.
public struct DecryptedMessage: Codable, Equatable, Sendable {
    /// Server uuid. Optimistic rows use the client `localId` until echoed.
    public var id: String
    /// Per-session insert counter; `null` on optimistic rows.
    public var seq: Int?
    /// Client-generated id for optimistic reconciliation.
    public var localId: String?
    /// Role-wrapped envelope, kept wire-verbatim (decoded by the chat pipeline).
    public var content: JSONValue
    /// Hub receive time (epoch ms).
    public var createdAt: Int
    /// When the agent consumed the message (epoch ms). `nil` covers both
    /// wire-`null` (still queued) and an absent key (pre-V8 hubs stamped
    /// rows as already invoked without the field). Current hubs always send
    /// the key, so treating `nil` as "queued" is correct against them; if
    /// pre-V8 hub support is ever needed, the M2 window store must
    /// distinguish explicit null (see pagination.md "Queued semantics").
    public var invokedAt: Int?
    /// Future-scheduled send time (epoch ms), when set.
    public var scheduledAt: Int?
    /// `indeterminate` means a steer outcome is unknown and needs explicit resolution.
    public var deliveryState: String?

    public init(
        id: String,
        seq: Int? = nil,
        localId: String? = nil,
        content: JSONValue = .null,
        createdAt: Int,
        invokedAt: Int? = nil,
        scheduledAt: Int? = nil,
        deliveryState: String? = nil
    ) {
        self.id = id
        self.seq = seq
        self.localId = localId
        self.content = content
        self.createdAt = createdAt
        self.invokedAt = invokedAt
        self.scheduledAt = scheduledAt
        self.deliveryState = deliveryState
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        seq = try container.decodeIfPresent(Int.self, forKey: .seq)
        localId = try container.decodeIfPresent(String.self, forKey: .localId)
        content = try container.decodeIfPresent(JSONValue.self, forKey: .content) ?? .null
        createdAt = try container.decode(Int.self, forKey: .createdAt)
        invokedAt = try container.decodeIfPresent(Int.self, forKey: .invokedAt)
        scheduledAt = try container.decodeIfPresent(Int.self, forKey: .scheduledAt)
        deliveryState = try container.decodeIfPresent(String.self, forKey: .deliveryState)
    }
}

/// Metadata describing an uploaded message attachment.
///
/// Mirrors `AttachmentMetadataSchema` (`shared/src/schemas.ts`). Used inside
/// user-message payloads and in the send-message request body.
public struct AttachmentMetadata: Codable, Equatable, Sendable {
    public var id: String
    public var filename: String
    public var mimeType: String
    /// Size in bytes.
    public var size: Int
    public var path: String
    /// Web-serving detail; present on wire payloads, absent from fixtures.
    public var previewUrl: String?

    public init(
        id: String,
        filename: String,
        mimeType: String,
        size: Int,
        path: String,
        previewUrl: String? = nil
    ) {
        self.id = id
        self.filename = filename
        self.mimeType = mimeType
        self.size = size
        self.path = path
        self.previewUrl = previewUrl
    }
}
