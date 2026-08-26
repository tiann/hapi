import Foundation

/*
 * Scratchlist wire surface (tiann/hapi#893, A-M4b) — the iOS twin of the
 * Android `protocol/wire/ScratchlistApi.kt`.
 *
 * Shapes mirror `ScratchlistEntrySchema` / `ScratchlistEntriesResponseSchema`
 * (`shared/src/schemas.ts`), the request schemas in `shared/src/apiTypes.ts`
 * and the attachment metadata/limits in `shared/src/scratchlistAttachments.ts`.
 * Endpoint behavior: `docs/api/client-contract/rest.md#scratchlist`
 * (`hub/src/web/routes/sessions.ts`).
 */

/// Caps from `shared/src/apiTypes.ts`.
public enum ScratchlistCaps {
    /// `SCRATCHLIST_MAX_ENTRIES` — POST past it → 409 `scratchlist_at_cap`.
    public static let maxEntries = 200

    /// `SCRATCHLIST_MAX_TEXT_LENGTH` — clients truncate (web behavior); the
    /// hub 400s anything longer. The hub counts JS string length (UTF-16
    /// units), so clients must clamp on that measure, not Characters.
    public static let maxTextLength = 10_000
}

/// Stable `code` discriminators of scratchlist error bodies (`{error, code}`).
public enum ScratchlistErrorCode {
    /// 409 on create when the session already holds ``ScratchlistCaps/maxEntries`` entries.
    public static let atCap = "scratchlist_at_cap"

    /// 413 on upload when the decoded file exceeds `limits.maxBytesPerFile`.
    public static let attachmentTooLarge = "scratchlist_attachment_too_large"

    /// 409 on attachment delete while an entry still references it.
    public static let attachmentInUse = "scratchlist_attachment_in_use"

    /// 400 when entry attachments fail resolution/validation (unknown id, budget, mime).
    public static let attachmentInvalid = "scratchlist_attachment_invalid"

    /// 400 when an update would leave the entry with neither text nor attachments.
    public static let entryEmpty = "scratchlist_entry_empty"
}

/// Persisted attachment metadata (`ScratchlistAttachmentMetadataSchema`).
/// `path` is the hub-resident storage path (`hapi-hub:scratchlist/…`) —
/// carried verbatim in entry writes, never interpreted client-side.
public struct ScratchlistAttachment: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var filename: String
    public var mimeType: String
    /// Decoded size in bytes.
    public var size: Int
    public var path: String

    public init(id: String, filename: String, mimeType: String, size: Int, path: String) {
        self.id = id
        self.filename = filename
        self.mimeType = mimeType
        self.size = size
        self.path = path
    }
}

/// One scratchlist entry (`ScratchlistEntrySchema`). Single-user notes —
/// last-write-wins, no version field.
public struct ScratchlistEntry: Codable, Equatable, Sendable, Identifiable {
    public var entryId: String
    public var text: String
    public var createdAt: Int
    public var updatedAt: Int
    public var attachments: [ScratchlistAttachment]

    public var id: String { entryId }

    public init(
        entryId: String,
        text: String,
        createdAt: Int,
        updatedAt: Int,
        attachments: [ScratchlistAttachment] = []
    ) {
        self.entryId = entryId
        self.text = text
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.attachments = attachments
    }

    private enum CodingKeys: String, CodingKey {
        case entryId
        case text
        case createdAt
        case updatedAt
        case attachments
    }

    public init(from decoder: Decoder) throws {
        // Hand-written only for the absent-`attachments` → `[]` default
        // (synthesized Codable would throw on the missing key).
        let container = try decoder.container(keyedBy: CodingKeys.self)
        entryId = try container.decode(String.self, forKey: .entryId)
        text = try container.decode(String.self, forKey: .text)
        createdAt = try container.decode(Int.self, forKey: .createdAt)
        updatedAt = try container.decode(Int.self, forKey: .updatedAt)
        attachments = try container.decodeIfPresent([ScratchlistAttachment].self, forKey: .attachments) ?? []
    }
}

/// `GET /api/sessions/:id/scratchlist`.
public struct ScratchlistEntriesResponse: Codable, Equatable, Sendable {
    public var entries: [ScratchlistEntry]

    public init(entries: [ScratchlistEntry]) {
        self.entries = entries
    }
}

/// Envelope of create (201/200) and update responses — the hub-canonical row.
public struct ScratchlistEntryResponse: Codable, Equatable, Sendable {
    public var entry: ScratchlistEntry

    public init(entry: ScratchlistEntry) {
        self.entry = entry
    }
}

/// `POST /api/sessions/:id/scratchlist` (`ScratchlistEntryCreateRequestSchema`).
/// `entryId`/`createdAt` are the idempotent-retry/migration knobs: an existing
/// `entryId` answers 200 with the canonical row instead of creating a twin.
/// Text or attachments required (schema refine). Synthesized Codable omits
/// nil optionals, matching the schema's absent-means-unset semantics.
public struct ScratchlistEntryCreateRequest: Codable, Equatable, Sendable {
    public var text: String
    public var entryId: String?
    public var createdAt: Int?
    public var attachments: [ScratchlistAttachment]?

    public init(
        text: String,
        entryId: String? = nil,
        createdAt: Int? = nil,
        attachments: [ScratchlistAttachment]? = nil
    ) {
        self.text = text
        self.entryId = entryId
        self.createdAt = createdAt
        self.attachments = attachments
    }
}

/// `PUT /api/sessions/:id/scratchlist/:entryId`
/// (`ScratchlistEntryUpdateRequestSchema`) — at least one field; absent means
/// "keep" (nil optionals are omitted on encode), `attachments = []` clears
/// the list.
public struct ScratchlistEntryUpdateRequest: Codable, Equatable, Sendable {
    public var text: String?
    public var attachments: [ScratchlistAttachment]?

    public init(text: String? = nil, attachments: [ScratchlistAttachment]? = nil) {
        self.text = text
        self.attachments = attachments
    }
}

/// `ScratchlistAttachmentLimitsSchema` (`shared/src/scratchlistAttachments.ts`).
public struct ScratchlistAttachmentLimits: Codable, Equatable, Sendable {
    public var maxBytesPerFile: Int
    public var maxAttachmentsPerEntry: Int
    public var maxBytesPerEntry: Int
    public var maxBytesPerSession: Int
    public var allowedMimeTypes: [String]

    public init(
        maxBytesPerFile: Int,
        maxAttachmentsPerEntry: Int,
        maxBytesPerEntry: Int,
        maxBytesPerSession: Int,
        allowedMimeTypes: [String]
    ) {
        self.maxBytesPerFile = maxBytesPerFile
        self.maxAttachmentsPerEntry = maxAttachmentsPerEntry
        self.maxBytesPerEntry = maxBytesPerEntry
        self.maxBytesPerSession = maxBytesPerSession
        self.allowedMimeTypes = allowedMimeTypes
    }

    /// `SCRATCHLIST_ATTACHMENT_DEFAULT_LIMITS` — the fallback when
    /// `GET …/scratchlist/limits` is unreachable (hub defaults are these
    /// exact values unless overridden by env).
    public static let defaultLimits = ScratchlistAttachmentLimits(
        maxBytesPerFile: 10 * 1024 * 1024,
        maxAttachmentsPerEntry: 4,
        maxBytesPerEntry: 20 * 1024 * 1024,
        maxBytesPerSession: 100 * 1024 * 1024,
        allowedMimeTypes: [
            "image/jpeg", "image/png", "image/gif", "image/webp",
            "image/svg+xml", "application/pdf", "text/plain",
        ]
    )
}

/// `GET /api/sessions/:id/scratchlist/limits`.
public struct ScratchlistLimitsResponse: Codable, Equatable, Sendable {
    public var limits: ScratchlistAttachmentLimits

    public init(limits: ScratchlistAttachmentLimits) {
        self.limits = limits
    }
}

/// `POST /api/sessions/:id/scratchlist/upload` — success is HTTP 200
/// `{success: true, attachment}`; failures are non-2xx (413
/// `scratchlist_attachment_too_large` / 400) and surface as ``APIError``-style
/// transport errors, so a decoded body always carries `attachment`.
public struct ScratchlistUploadResponse: Codable, Equatable, Sendable {
    public var success: Bool
    public var attachment: ScratchlistAttachment?
    public var error: String?
    public var code: String?

    public init(
        success: Bool,
        attachment: ScratchlistAttachment? = nil,
        error: String? = nil,
        code: String? = nil
    ) {
        self.success = success
        self.attachment = attachment
        self.error = error
        self.code = code
    }
}
