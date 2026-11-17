package app.hapi.protocol.wire

import java.net.URI
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import kotlinx.serialization.Serializable
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
 * models. [NativePasskeys.registrationOptions] validates Hub/RP binding and
 * selects supported fields of Hub-issued creation options;
 * [NativePasskeys.nativeLoginOptions] builds sign-in options locally. Credential
 * Manager then produces `RegistrationResponseJSON` / `AuthenticationResponseJSON`.
 */

/**
 * Body of `POST /api/passkey/register/options`. [client] has no
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

    /**
     * Throws [PasskeyRpMismatchException] unless the creation options target
     * [expected]. Refusing a mismatch keeps a hub from steering the app into
     * a ceremony for a relying party it does not own.
     */
    fun requireCreationRpId(optionsJson: String, expected: String = RP_ID) {
        val actual = creationRpId(optionsJson)
        if (actual != expected) throw PasskeyRpMismatchException(expected, actual)
    }

    /** Reject registration options for a different Hub/operation/channel before invoking Credential Manager. */
    fun requireHubBinding(optionsJson: String, hubUrl: String) {
        val options = parseObject(optionsJson) ?: error("Invalid passkey options")
        val hub = canonicalHub(hubUrl)
        val encoded = options["challenge"].stringOrNull ?: error("Missing passkey challenge")
        require(encoded.length <= 4096)
        val challenge = parseObject(String(Base64.getUrlDecoder().decode(encoded), Charsets.UTF_8))
            ?: error("Invalid passkey challenge")
        require(challenge["v"].toString() == "1" && challenge["hub"].stringOrNull == hub
            && challenge["operation"].stringOrNull == "register" && challenge["channel"].stringOrNull == "native"
            && challenge["id"].stringOrNull?.matches(NONCE) == true
            && challenge["nonce"].stringOrNull?.matches(NONCE) == true) {
            "Passkey challenge does not match this Hub or operation"
        }
        val user = options["user"].objOrNull ?: error("Missing passkey account")
        val handle = Base64.getUrlDecoder().decode(user["id"].stringOrNull ?: error("Missing passkey account"))
        require(handleBelongsTo(handle, hub)) { "Passkey account belongs to another Hub" }
        require(user["name"].stringOrNull?.endsWith("@${URI(hub).rawAuthority}") == true)
    }

    /** Discoverable handle → equal origin; opaque (long address) → SHA-256(origin) prefix. */
    private fun handleBelongsTo(handle: ByteArray, hub: String): Boolean {
        val discovered = userHandleHub(handle)
        if (discovered != null) return discovered == hub
        val prefix = MessageDigest.getInstance("SHA-256").digest(hub.toByteArray(Charsets.UTF_8))
        return handle.copyOfRange(2, 34).contentEquals(prefix)
    }

    private fun canonicalHub(hubUrl: String): String {
        val uri = URI(hubUrl)
        require(uri.scheme.equals("https", ignoreCase = true) && uri.host != null && uri.rawUserInfo == null
            && uri.rawQuery == null && uri.rawFragment == null && (uri.path.isNullOrEmpty() || uri.path == "/"))
        val port = if (uri.port == -1 || uri.port == 443) "" else ":${uri.port}"
        return "https://${uri.host.lowercase()}$port"
    }

    /** v2: [2, authority length, authority, 16-byte account tag], HTTPS implicit.
     * Length 0 is a hash-bound long address, usable only with manual entry. */
    fun userHandleHub(handle: ByteArray): String? {
        require(handle.size in 2..64 && handle[0].toInt() == 2) { "Invalid passkey account" }
        val length = handle[1].toInt() and 255
        if (length == 0 && handle.size == 50) return null
        require(length in 1..46 && handle.size == length + 18)
        val bytes = handle.copyOfRange(2, 2 + length)
        require(bytes.all { it.toInt() in 33..126 })
        val hub = "https://${String(bytes, Charsets.US_ASCII)}"
        require(canonicalHub(hub) == hub)
        return hub
    }

    /**
     * Native sign-in is one ceremony: the app signs its own fresh challenge
     * (shared `createPasskeyNativeLoginChallenge`) before it knows the Hub,
     * then posts the assertion to the Hub named by the credential's user
     * handle. The Hub accepts it within a short [nowMs] window, once.
     * Never derived from Hub-supplied options: no `allowCredentials`, no
     * extensions.
     */
    fun nativeLoginOptions(nowMs: Long): String {
        val b64 = Base64.getUrlEncoder().withoutPadding()
        val nonce = ByteArray(32).also { SecureRandom().nextBytes(it) }
        val challenge = buildJsonObject {
            put("v", NATIVE_LOGIN_VERSION); put("operation", "login"); put("channel", "native")
            put("iat", nowMs); put("nonce", b64.encodeToString(nonce))
        }
        return buildJsonObject {
            put("challenge", b64.encodeToString(challenge.toString().toByteArray(Charsets.UTF_8)))
            put("rpId", RP_ID); put("userVerification", "required"); put("timeout", 120000)
        }.toString()
    }

    /**
     * The Hub an assertion from [nativeLoginOptions] must be posted to, read
     * from `response.userHandle` (a locator, never evidence — the Hub verifies
     * the signature). With [expectedHub] (manual entry) the handle must belong
     * to that Hub, else [PasskeyHubMismatchException]. Without one, a missing,
     * opaque (long address) or unreadable handle throws
     * [PasskeyHubAddressRequiredException] so the user can enter the address.
     */
    fun loginHub(responseJson: String, expectedHub: String?): String {
        val handle = try {
            val encoded = parseObject(responseJson)?.get("response").objOrNull?.get("userHandle").stringOrNull
            encoded?.takeIf { it.length <= 88 }?.let { Base64.getUrlDecoder().decode(it) }
        } catch (_: IllegalArgumentException) {
            null
        }
        if (expectedHub != null) {
            val hub = canonicalHub(expectedHub)
            val belongs = handle != null && try {
                handleBelongsTo(handle, hub)
            } catch (_: Exception) {
                false
            }
            if (!belongs) throw PasskeyHubMismatchException(hub)
            return hub
        }
        return try {
            handle?.let(::userHandleHub)
        } catch (_: Exception) {
            null
        } ?: throw PasskeyHubAddressRequiredException()
    }

    /** Only the WebAuthn fields this client supports reach Credential Manager.
     * In particular, an untrusted Hub cannot ask for PRF/largeBlob extensions
     * on credentials that share this RP with other Hubs. Registration only:
     * sign-in options are generated locally by [nativeLoginOptions]. */
    fun registrationOptions(optionsJson: String, hubUrl: String): String {
        requireCreationRpId(optionsJson)
        requireHubBinding(optionsJson, hubUrl)
        val input = parseObject(optionsJson)!!
        return buildJsonObject {
            put("challenge", input.getValue("challenge"))
            put("timeout", 120000)
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

    /** `PASSKEY_NATIVE_LOGIN_VERSION` in `shared/src/passkey.ts`. */
    private const val NATIVE_LOGIN_VERSION: Int = 2
    private val NONCE = Regex("[A-Za-z0-9_-]{43}")

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

/** The selected passkey does not name its Hub (long address): enter it manually. */
class PasskeyHubAddressRequiredException : IllegalStateException("Enter the Hub address manually")

/** The selected passkey belongs to a Hub other than the one entered. */
class PasskeyHubMismatchException(val expectedHub: String) :
    IllegalStateException("Passkey account does not belong to $expectedHub")
