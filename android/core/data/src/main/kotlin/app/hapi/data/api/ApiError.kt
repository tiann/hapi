package app.hapi.data.api

import app.hapi.protocol.wire.objOrNull
import app.hapi.protocol.wire.stringOrNull
import kotlinx.serialization.json.Json

/**
 * Non-2xx hub response (`docs/api/client-contract/errors.md`), the native twin
 * of the web `ApiError` (`web/src/api/client.ts`).
 *
 * Error bodies are `{error: string, code?: string}`. Branch on
 * `(status, code)` — [code] is the stable machine discriminator (e.g.
 * `session_inactive`, `rpc_target_missing`); when the body has no `code`, the
 * web reference falls back to the `error` string as a pseudo-code, mirrored
 * here — fine for logging, never for logic. [body] keeps the raw text for
 * detail views.
 */
class ApiError(
    val status: Int,
    val code: String? = null,
    val body: String? = null,
    message: String = "HTTP $status${if (body.isNullOrEmpty()) "" else ": $body"}",
) : Exception(message) {

    companion object {
        /** Builds an [ApiError] from a response's status + raw body text. */
        fun from(status: Int, body: String?): ApiError = ApiError(
            status = status,
            code = parseErrorCode(body),
            body = body?.takeIf { it.isNotEmpty() },
        )

        /**
         * `code` if present, else the `error` string as pseudo-code
         * (`parseErrorCode` in the web reference); null for non-JSON bodies.
         */
        fun parseErrorCode(body: String?): String? {
            if (body.isNullOrBlank()) return null
            val parsed = try {
                Json.parseToJsonElement(body)
            } catch (_: Exception) {
                return null
            }.objOrNull ?: return null
            return parsed["code"].stringOrNull ?: parsed["error"].stringOrNull
        }
    }
}
