package app.hapi.data.auth

import java.util.concurrent.ConcurrentHashMap
import kotlinx.serialization.Serializable

/**
 * Credentials for one paired hub, keyed by normalized hub origin
 * ([HubUrls.normalize]).
 *
 * The **access token** is the durable secret from pairing
 * (`hapicompanion://bind?...&code=`), exchanged for a 4-hour [jwt] via
 * `POST /api/auth`. It is opaque — never split client-side; the optional
 * `:namespace` suffix is interpreted by the hub only
 * (`docs/api/client-contract/auth.md`). The JWT is a cache: persisting it just
 * saves one exchange round-trip on cold start.
 */
@Serializable
data class HubCredentials(
    /** Normalized hub origin, e.g. `https://hub.example:8443`. */
    val hubUrl: String,
    /** Opaque pairing secret (`CLI_API_TOKEN[:namespace]`). */
    val accessToken: String,
    /** Last JWT from `POST /api/auth`, or null before the first exchange. */
    val jwt: String? = null,
    /** Epoch ms when [jwt] was obtained, or null. */
    val jwtObtainedAtMs: Long? = null,
)

/**
 * Per-hub credential storage. Production uses [EncryptedPrefsCredentialStore]
 * (androidx.security-crypto); the interface keeps the mechanism swappable
 * (e.g. a direct-Keystore implementation) and tests hermetic
 * ([InMemoryCredentialStore]).
 *
 * Implementations may perform blocking I/O — call from a background thread
 * (OkHttp interceptor/authenticator threads qualify). Keys are normalized with
 * [HubUrls.normalize] internally, so any spelling of the same origin hits the
 * same entry.
 */
interface CredentialStore {
    fun get(hubUrl: String): HubCredentials?
    fun set(credentials: HubCredentials)
    fun delete(hubUrl: String)
}

/** Normalized storage key for [hubUrl]; falls back to the raw string. */
internal fun credentialKey(hubUrl: String): String = HubUrls.normalize(hubUrl) ?: hubUrl

/** Hermetic in-memory [CredentialStore] for tests and previews. */
class InMemoryCredentialStore : CredentialStore {
    private val entries = ConcurrentHashMap<String, HubCredentials>()

    override fun get(hubUrl: String): HubCredentials? = entries[credentialKey(hubUrl)]

    override fun set(credentials: HubCredentials) {
        entries[credentialKey(credentials.hubUrl)] = credentials
    }

    override fun delete(hubUrl: String) {
        entries.remove(credentialKey(hubUrl))
    }
}
