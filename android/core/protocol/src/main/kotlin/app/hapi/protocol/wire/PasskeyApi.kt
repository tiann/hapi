package app.hapi.protocol.wire

import java.net.URI
import java.security.MessageDigest
import java.util.Base64
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.put

/**
 * Native passkey wire types (`docs/api/client-contract/auth.md#passkeys-native`;
 * `PasskeyOptionsRequestSchema`, `PasskeyRegisterVerifyRequestSchema`,
 * `PasskeyLoginVerifyRequestSchema`, `PasskeySummary` in
 * `shared/src/apiTypes.ts`).
 *
 * WebAuthn options and credential responses use JSON rather than full wire
 * models. [NativePasskeys.ceremonyOptions] validates Hub/RP binding and selects
 * supported fields before Credential Manager consumes the options and produces
 * `RegistrationResponseJSON` / `AuthenticationResponseJSON`.
 */

/**
 * Body of `POST /api/passkey/{register,login}/options`. [client] has no
 * default on purpose: [HapiJson] does not encode defaults, and direct
 * options endpoints require an explicit native client.
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
    /** Shared Web/App RP ID (`auth.hapi.run`). */
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
    /** RP ID compiled into the official apps (asset links on `auth.hapi.run`). */
    const val RP_ID: String = "auth.hapi.run"

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

    /** Reject a different Hub/operation/channel before invoking Credential Manager. */
    fun requireHubBinding(optionsJson: String, hubUrl: String, operation: String) {
        require(operation == "login" || operation == "register")
        val options = parseObject(optionsJson) ?: error("Invalid passkey options")
        val uri = URI(hubUrl)
        require(uri.scheme.equals("https", ignoreCase = true) && uri.host != null && uri.rawUserInfo == null
            && uri.rawQuery == null && uri.rawFragment == null && (uri.path.isNullOrEmpty() || uri.path == "/"))
        val port = if (uri.port == -1 || uri.port == 443) "" else ":${uri.port}"
        val hub = "https://${uri.host.lowercase()}$port"
        val encoded = options["challenge"].stringOrNull ?: error("Missing passkey challenge")
        require(encoded.length <= 4096)
        val challenge = parseObject(String(Base64.getUrlDecoder().decode(encoded), Charsets.UTF_8))
            ?: error("Invalid passkey challenge")
        require(challenge["v"].toString() == "1" && challenge["hub"].stringOrNull == hub
            && challenge["operation"].stringOrNull == operation && challenge["channel"].stringOrNull == "native"
            && challenge["id"].stringOrNull?.matches(Regex("[A-Za-z0-9_-]{43}")) == true
            && challenge["nonce"].stringOrNull?.matches(Regex("[A-Za-z0-9_-]{43}")) == true) {
            "Passkey challenge does not match this Hub or operation"
        }
        if (operation == "login") require((options["allowCredentials"] as? JsonArray)?.isNotEmpty() == true)
        if (operation == "register") {
            val user = options["user"].objOrNull ?: error("Missing passkey account")
            val handle = Base64.getUrlDecoder().decode(user["id"].stringOrNull ?: error("Missing passkey account"))
            val prefix = MessageDigest.getInstance("SHA-256").digest(hub.toByteArray(Charsets.UTF_8))
            require(handle.size == 64 && handle.copyOfRange(0, 32).contentEquals(prefix)) { "Passkey account belongs to another Hub" }
            require(user["name"].stringOrNull?.endsWith("@${URI(hub).rawAuthority}") == true)
        }
    }

    /** Only the WebAuthn fields this client supports reach Credential Manager.
     * In particular, an untrusted Hub cannot ask for PRF/largeBlob extensions
     * on credentials that share this RP with other Hubs. */
    fun ceremonyOptions(optionsJson: String, hubUrl: String, operation: String): String {
        if (operation == "register") requireCreationRpId(optionsJson) else requireRequestRpId(optionsJson)
        requireHubBinding(optionsJson, hubUrl, operation)
        val input = parseObject(optionsJson)!!
        return buildJsonObject {
            put("challenge", input.getValue("challenge"))
            put("timeout", 120000)
            if (operation == "login") {
                put("rpId", RP_ID)
                put("allowCredentials", input.getValue("allowCredentials"))
                put("userVerification", "required")
            } else {
                put("rp", buildJsonObject { put("id", RP_ID); put("name", "HAPI") })
                val user = input.getValue("user").objOrNull!!
                put("user", buildJsonObject {
                    put("id", user.getValue("id")); put("name", user.getValue("name"))
                    put("displayName", "HAPI · ${URI(hubUrl).rawAuthority.lowercase()}")
                })
                put("pubKeyCredParams", buildJsonArray {
                    for (alg in listOf(-7, -257)) add(buildJsonObject { put("alg", alg); put("type", "public-key") })
                })
                input["excludeCredentials"]?.let { put("excludeCredentials", it) }
                put("authenticatorSelection", buildJsonObject {
                    put("residentKey", "required"); put("userVerification", "required")
                })
                put("attestation", "none")
            }
        }.toString()
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
