package app.hapi.protocol.wire

import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * Session export wire surface (`shared/src/sessionExport.ts`, hub route
 * `GET /api/sessions/:id/export` in `hub/src/web/routes/sessions.ts`).
 *
 * - 200 with a payload object → [SessionExportResponse.Full] (the raw element
 *   is kept alongside the typed view: the JSON outlet re-encodes it, so
 *   fields this DTO set doesn't model survive the round trip — zod's
 *   key-stripping parity means the hub-produced payload has no extras, but
 *   re-encoding the DTO would still *drop* the nulls web's
 *   `JSON.stringify` keeps).
 * - 200 with `{type: 'warning', …}` → [SessionExportResponse.Warning]; the
 *   client refetches with `force=true` after user confirmation.
 * - 413 `{type: 'too-large', …}` → surfaces as [ApiError] with code
 *   [SESSION_EXPORT_TOO_LARGE_CODE]; details parse via
 *   [SessionExportTooLarge.fromBody].
 */

/** `HAPI_SESSION_EXPORT_SCHEMA_VERSION` — v2 adds scratchlist + attachment metadata. */
const val SESSION_EXPORT_SCHEMA_VERSION: Int = 2

/** `SESSION_EXPORT_MESSAGE_LIMIT` — over this the hub answers the warning (unless forced). */
const val SESSION_EXPORT_MESSAGE_LIMIT: Int = 20_000

/** `SESSION_EXPORT_MAX_BYTES` — the client-side second guard on the built artifact. */
const val SESSION_EXPORT_MAX_BYTES: Long = 100L * 1024 * 1024

/** Stable `code` of the 413 too-large body. */
const val SESSION_EXPORT_TOO_LARGE_CODE: String = "session_export_too_large"

/** `HapiSessionExportSchema` — schema v2 (attachment bytes intentionally omitted). */
@Serializable
data class SessionExport(
    val schemaVersion: Int,
    val exportedAt: Long,
    val session: Session,
    val messages: List<DecryptedMessage> = emptyList(),
    val scratchlist: List<ScratchlistEntry> = emptyList(),
)

/** `HapiSessionExportWarning` (minus its wire-only `type` tag). */
@Serializable
data class SessionExportWarning(
    val count: Int,
    val limit: Int,
    val estimatedBytes: Long,
)

/** `HapiSessionExportTooLarge` (minus its wire-only `type` tag). */
@Serializable
data class SessionExportTooLarge(
    val count: Int,
    val estimatedBytes: Long,
    val maxBytes: Long,
) {
    companion object {
        /**
         * Parses a 413 error body, validating exactly like the web's
         * `parseSessionExportTooLarge`: `type` must be `'too-large'` and all
         * three numbers present; anything else → null.
         */
        fun fromBody(body: String?): SessionExportTooLarge? {
            if (body.isNullOrBlank()) return null
            val obj = try {
                HapiJson.parseToJsonElement(body) as? JsonObject
            } catch (_: Exception) {
                null
            } ?: return null
            if (obj["type"].stringOrNull != "too-large") return null
            val count = obj["count"].intOrNull ?: return null
            val estimatedBytes = obj["estimatedBytes"].longOrNull ?: return null
            val maxBytes = obj["maxBytes"].longOrNull ?: return null
            return SessionExportTooLarge(count, estimatedBytes, maxBytes)
        }
    }
}

/** 200 body: the export payload, or the over-limit warning. */
sealed class SessionExportResponse {

    /** [raw] is the verbatim payload element (the JSON outlet re-encodes it). */
    data class Full(val export: SessionExport, val raw: JsonElement) : SessionExportResponse()

    data class Warning(val warning: SessionExportWarning) : SessionExportResponse()

    companion object {
        /** Discriminates on the `type` tag, like the web's response-narrow guard. */
        fun from(element: JsonElement): SessionExportResponse {
            val obj = element as? JsonObject
                ?: throw SerializationException("Session export response must be a JSON object")
            if (obj["type"].stringOrNull == "warning") {
                return Warning(HapiJson.decodeFromJsonElement(SessionExportWarning.serializer(), obj))
            }
            return Full(
                export = HapiJson.decodeFromJsonElement(SessionExport.serializer(), obj),
                raw = element,
            )
        }

        fun parse(text: String): SessionExportResponse = from(HapiJson.parseToJsonElement(text))
    }
}
