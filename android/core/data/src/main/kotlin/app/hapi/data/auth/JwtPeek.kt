package app.hapi.data.auth

import app.hapi.protocol.wire.longOrNull
import app.hapi.protocol.wire.objOrNull
import app.hapi.protocol.wire.stringOrNull
import java.util.Base64
import kotlinx.serialization.json.Json

/**
 * Claims peeked (NOT verified) from a hub JWT payload.
 *
 * The hub signs `{uid, ns}` plus standard `iat`/`exp` with HS256
 * (`hub/src/web/routes/auth.ts`); the secret is hub-local, so clients treat
 * the token as opaque for auth — but may read the payload for proactive
 * refresh scheduling and namespace-gated UI (`docs/api/client-contract/auth.md`).
 */
data class JwtClaims(
    val uid: Long? = null,
    /** Namespace; `"default"` = hub owner (usage/storage surfaces visible). */
    val ns: String? = null,
    /** Expiry in epoch **milliseconds** (wire `exp` is seconds), or null. */
    val expiresAtMs: Long? = null,
)

/**
 * Decodes a JWT's payload segment without signature verification — the native
 * twin of the web's `decodeJwtExpMs` (`web/src/hooks/useAuth.ts`).
 */
object JwtPeek {

    /** Peeks [jwt]'s payload claims; null when the token is not a decodable JWT. */
    fun peek(jwt: String): JwtClaims? {
        val parts = jwt.split('.')
        if (parts.size != 3) return null
        val payloadBytes = try {
            // JWT segments are base64url without padding; Java's URL decoder
            // accepts unpadded input and rejects `+`/`/`.
            Base64.getUrlDecoder().decode(parts[1])
        } catch (_: IllegalArgumentException) {
            return null
        }
        val payload = try {
            Json.parseToJsonElement(String(payloadBytes, Charsets.UTF_8))
        } catch (_: Exception) {
            return null
        }.objOrNull ?: return null
        return JwtClaims(
            uid = payload["uid"].longOrNull,
            ns = payload["ns"].stringOrNull,
            expiresAtMs = payload["exp"].longOrNull?.let { it * 1000 },
        )
    }

    /** Convenience: expiry in epoch ms, or null when absent/undecodable. */
    fun expiresAtMs(jwt: String): Long? = peek(jwt)?.expiresAtMs
}
