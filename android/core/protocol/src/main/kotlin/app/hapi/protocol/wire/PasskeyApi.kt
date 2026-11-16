package app.hapi.protocol.wire

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject

/**
 * Native passkey wire types (`docs/api/client-contract/auth.md#passkeys-native`;
 * `PasskeyOptionsRequestSchema`, `PasskeyRegisterVerifyRequestSchema`,
 * `PasskeyLoginVerifyRequestSchema`, `PasskeySummary` in
 * `shared/src/apiTypes.ts`).
 *
 * The WebAuthn options and credential responses are passed through as raw
 * JSON: Credential Manager consumes `PublicKeyCredential*OptionsJSON` as-is
 * and produces `RegistrationResponseJSON` / `AuthenticationResponseJSON`, so
 * the app never models their (base64url) fields.
 */

/**
 * Body of `POST /api/passkey/{register,login}/options`. [client] has no
 * default on purpose: [HapiJson] does not encode defaults, and the hub falls
 * back to the web (Origin-derived) relying party when the field is absent.
 */
@Serializable
data class PasskeyOptionsRequest(
    val client: String,
) {
    companion object {
        const val CLIENT_NATIVE: String = "native"

        val Native: PasskeyOptionsRequest = PasskeyOptionsRequest(CLIENT_NATIVE)
    }
}

/** `POST /api/passkey/register/verify`. [name] is trimmed/≤64 chars hub-side. */
@Serializable
data class PasskeyRegisterVerifyRequest(
    /** `RegistrationResponseJSON` from the platform authenticator. */
    val response: JsonElement,
    val name: String? = null,
)

/** `POST /api/passkey/login/verify`. */
@Serializable
data class PasskeyLoginVerifyRequest(
    /** `AuthenticationResponseJSON` from the platform authenticator. */
    val response: JsonElement,
)

/**
 * `POST /api/passkey/login/verify` success: a 4-hour JWT plus the durable
 * [passkeySession] refresh credential (exchanged via `POST /api/auth`).
 */
@Serializable
data class PasskeyLoginResponse(
    val token: String,
    val user: AuthUser,
    val passkeySession: String,
)

/** One row of `GET /api/passkeys` (`PasskeySummary`). */
@Serializable
data class PasskeySummary(
    val id: String,
    val name: String? = null,
    /** `hapi.run` for app passkeys; any other value is a web passkey. */
    val rpId: String,
    val createdAt: Long,
    val lastUsedAt: Long? = null,
    /** False once `CLI_API_TOKEN` was rotated after registration. */
    val valid: Boolean = true,
)

@Serializable
data class PasskeyListResponse(
    val passkeys: List<PasskeySummary> = emptyList(),
)

/** The relying-party rules native apps must enforce before a ceremony. */
object NativePasskeys {
    /** RP ID compiled into the official apps (asset links on `hapi.run`). */
    const val RP_ID: String = "hapi.run"

    /** Hub-side limit on passkey names (`PasskeyRegisterVerifyRequestSchema`). */
    const val MAX_NAME_LENGTH: Int = 64

    /** `rp.id` of `PublicKeyCredentialCreationOptionsJSON`, or null if absent/unparsable. */
    fun creationRpId(optionsJson: String): String? =
        parseObject(optionsJson)?.get("rp").objOrNull?.get("id").stringOrNull

    /** `rpId` of `PublicKeyCredentialRequestOptionsJSON`, or null if absent/unparsable. */
    fun requestRpId(optionsJson: String): String? =
        parseObject(optionsJson)?.get("rpId").stringOrNull

    /**
     * Throws [PasskeyRpMismatchException] unless the creation options target
     * [expected]. Refusing a mismatch keeps a hub from steering the app into
     * a ceremony for a relying party it does not own.
     */
    fun requireCreationRpId(optionsJson: String, expected: String = RP_ID) {
        val actual = creationRpId(optionsJson)
        if (actual != expected) throw PasskeyRpMismatchException(expected, actual)
    }

    /** As [requireCreationRpId], for request (sign-in) options. */
    fun requireRequestRpId(optionsJson: String, expected: String = RP_ID) {
        val actual = requestRpId(optionsJson)
        if (actual != expected) throw PasskeyRpMismatchException(expected, actual)
    }

    /**
     * Parses a platform credential response for embedding as `response`.
     * Top-level JSON `null`s are dropped: the hub schema allows optional
     * fields (e.g. `authenticatorAttachment`) to be absent but not `null`,
     * and some providers serialize unset members as `null`.
     */
    fun credentialResponse(responseJson: String): JsonObject {
        val parsed = parseObject(responseJson)
            ?: throw IllegalArgumentException("Credential response is not a JSON object")
        return JsonObject(parsed.filterValues { it !is JsonNull })
    }

    /** Clamps a user-entered name to what the hub accepts; blank → null. */
    fun normalizeName(name: String?): String? =
        name?.trim()?.take(MAX_NAME_LENGTH)?.trim()?.takeIf { it.isNotEmpty() }

    private fun parseObject(json: String): JsonObject? = try {
        HapiJson.parseToJsonElement(json) as? JsonObject
    } catch (_: Exception) {
        null
    }
}

/** The hub's WebAuthn options target a relying party other than the compiled one. */
class PasskeyRpMismatchException(
    val expected: String,
    val actual: String?,
) : IllegalStateException("Passkey RP ID mismatch: expected $expected, got ${actual ?: "none"}")
