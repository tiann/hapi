package app.hapi.protocol.wire

import kotlinx.serialization.Serializable

/*
 * Scratchlist wire surface (tiann/hapi#893, B-M4d).
 *
 * Shapes mirror `ScratchlistEntrySchema` / `ScratchlistEntriesResponseSchema`
 * (`shared/src/schemas.ts`), the request schemas in `shared/src/apiTypes.ts`
 * and the attachment metadata/limits in `shared/src/scratchlistAttachments.ts`.
 * Endpoint behavior: `docs/api/client-contract/rest.md#scratchlist`
 * (`hub/src/web/routes/sessions.ts`).
 */

/** `SCRATCHLIST_MAX_ENTRIES` (`shared/src/apiTypes.ts`) — POST past it → 409 [ScratchlistErrorCodes.AT_CAP]. */
const val SCRATCHLIST_MAX_ENTRIES: Int = 200

/** `SCRATCHLIST_MAX_TEXT_LENGTH` — clients truncate (web behavior); the hub 400s anything longer. */
const val SCRATCHLIST_MAX_TEXT_LENGTH: Int = 10_000

/** Stable `code` discriminators of scratchlist error bodies (`{error, code}`). */
object ScratchlistErrorCodes {
    /** 409 on create when the session already holds [SCRATCHLIST_MAX_ENTRIES] entries. */
    const val AT_CAP = "scratchlist_at_cap"

    /** 413 on upload when the decoded file exceeds `limits.maxBytesPerFile`. */
    const val ATTACHMENT_TOO_LARGE = "scratchlist_attachment_too_large"

    /** 409 on attachment delete while an entry still references it. */
    const val ATTACHMENT_IN_USE = "scratchlist_attachment_in_use"

    /** 400 when entry attachments fail resolution/validation (unknown id, budget, mime). */
    const val ATTACHMENT_INVALID = "scratchlist_attachment_invalid"

    /** 400 when an update would leave the entry with neither text nor attachments. */
    const val ENTRY_EMPTY = "scratchlist_entry_empty"
}

/**
 * Persisted attachment metadata (`ScratchlistAttachmentMetadataSchema`).
 * [path] is the hub-resident storage path (`hapi-hub:scratchlist/…`) — carried
 * verbatim in entry writes, never interpreted client-side.
 */
@Serializable
data class ScratchlistAttachment(
    val id: String,
    val filename: String,
    val mimeType: String,
    /** Decoded size in bytes. */
    val size: Long,
    val path: String,
)

/**
 * One scratchlist entry (`ScratchlistEntrySchema`). Single-user notes —
 * last-write-wins, no version field.
 */
@Serializable
data class ScratchlistEntry(
    val entryId: String,
    val text: String,
    val createdAt: Long,
    val updatedAt: Long,
    val attachments: List<ScratchlistAttachment> = emptyList(),
)

/** `GET /api/sessions/:id/scratchlist`. */
@Serializable
data class ScratchlistEntriesResponse(
    val entries: List<ScratchlistEntry>,
)

/** Envelope of create (201/200) and update responses — the hub-canonical row. */
@Serializable
data class ScratchlistEntryResponse(
    val entry: ScratchlistEntry,
)

/**
 * `POST /api/sessions/:id/scratchlist` (`ScratchlistEntryCreateRequestSchema`).
 * [entryId]/[createdAt] are the idempotent-retry/migration knobs: an existing
 * [entryId] answers 200 with the canonical row instead of creating a twin.
 * Text or attachments required (schema refine).
 */
@Serializable
data class ScratchlistEntryCreateRequest(
    val text: String,
    val entryId: String? = null,
    val createdAt: Long? = null,
    val attachments: List<ScratchlistAttachment>? = null,
)

/**
 * `PUT /api/sessions/:id/scratchlist/:entryId`
 * (`ScratchlistEntryUpdateRequestSchema`) — at least one field; absent means
 * "keep" ([HapiJson] omits nulls), `attachments = []` clears the list.
 */
@Serializable
data class ScratchlistEntryUpdateRequest(
    val text: String? = null,
    val attachments: List<ScratchlistAttachment>? = null,
)

/** `ScratchlistAttachmentLimitsSchema` (`shared/src/scratchlistAttachments.ts`). */
@Serializable
data class ScratchlistAttachmentLimits(
    val maxBytesPerFile: Long,
    val maxAttachmentsPerEntry: Int,
    val maxBytesPerEntry: Long,
    val maxBytesPerSession: Long,
    val allowedMimeTypes: List<String>,
) {
    companion object {
        /**
         * `SCRATCHLIST_ATTACHMENT_DEFAULT_LIMITS` — the fallback when
         * `GET …/scratchlist/limits` is unreachable (hub defaults are these
         * exact values unless overridden by env).
         */
        val DEFAULT = ScratchlistAttachmentLimits(
            maxBytesPerFile = 10L * 1024 * 1024,
            maxAttachmentsPerEntry = 4,
            maxBytesPerEntry = 20L * 1024 * 1024,
            maxBytesPerSession = 100L * 1024 * 1024,
            allowedMimeTypes = listOf(
                "image/jpeg", "image/png", "image/gif", "image/webp",
                "image/svg+xml", "application/pdf", "text/plain",
            ),
        )
    }
}

/** `GET /api/sessions/:id/scratchlist/limits`. */
@Serializable
data class ScratchlistLimitsResponse(
    val limits: ScratchlistAttachmentLimits,
)

/**
 * `POST /api/sessions/:id/scratchlist/upload` — success is HTTP 200
 * `{success: true, attachment}`; failures are non-2xx (413
 * [ScratchlistErrorCodes.ATTACHMENT_TOO_LARGE] / 400) and surface as
 * `ApiError`, so a decoded body always carries [attachment].
 */
@Serializable
data class ScratchlistUploadResponse(
    val success: Boolean,
    val attachment: ScratchlistAttachment? = null,
    val error: String? = null,
    val code: String? = null,
)
