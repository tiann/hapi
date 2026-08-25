package app.hapi.companion.feature.sessions

import app.hapi.data.api.ApiError
import app.hapi.protocol.wire.arrayOrNull
import app.hapi.protocol.wire.objOrNull
import app.hapi.protocol.wire.stringOrNull
import kotlinx.serialization.json.Json

/**
 * Human-readable message for a reopen/resume failure (web
 * `formatReopenError`, `reopenError.ts`): the hub 422s with
 * `{error, missing: [...]}` when required metadata is gone (e.g. a Cursor
 * session without `cursorSessionId`); other errors carry `{error, code?}`.
 * Falls back to the raw exception message when the body is unparseable, and
 * to null when there is no message at all — the UI layer then shows its
 * localized "failed to reopen" fallback (B-M5a).
 */
fun formatReopenError(error: Exception): String? {
    val fallback = error.message
    val body = (error as? ApiError)?.body ?: return fallback
    val parsed = try {
        Json.parseToJsonElement(body).objOrNull
    } catch (_: Exception) {
        null
    } ?: return fallback
    val message = parsed["error"].stringOrNull ?: return fallback
    val missing = parsed["missing"].arrayOrNull?.mapNotNull { it.stringOrNull }.orEmpty()
    return if (missing.isEmpty()) message else "$message (missing: ${missing.joinToString(", ")})"
}
