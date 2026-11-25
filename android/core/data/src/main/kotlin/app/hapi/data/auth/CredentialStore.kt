package app.hapi.data.auth

import app.hapi.protocol.wire.AuthRequest
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.serialization.Serializable

/**
 * Credentials for one paired hub, keyed by normalized hub origin
 * ([HubUrls.normalize]).
 *
 * A hub is authenticated by **one of two durable secrets**:
 *
 * - the **access token** from pairing (`hapicompanion://bind?...&code=`), or
 * - the **passkey session** minted by `POST /api/passkey/login/verify`
 *   (`docs/api/client-contract/auth.md#passkeys-native`) — signing in with a
 *   passkey never requires the access token.
 *
 * Either is exchanged for a 4-hour [jwt] via `POST /api/auth`; the body
 * carries whichever one exists ([authRequest]). An access token is opaque —
 * never split client-side; the optional `:namespace` suffix is interpreted by
 * the hub only. The JWT is a cache: persisting it just saves one exchange
 * round-trip on cold start.
 *
 * Both fields are nullable because the two sign-in paths populate different
 * ones; at least one is always set for a usable entry ([hasCredential]).
 */
@Serializable
data class HubCredentials(
    /** Normalized hub origin, e.g. `https://hub.example:8443`. */
    val hubUrl: String,
    /** Opaque pairing secret (`CLI_API_TOKEN[:namespace]`), when paired. */
    val accessToken: String? = null,
    /** Passkey refresh credential, when signed in with a passkey. */
    val passkeySession: String? = null,
    /** Last JWT from `POST /api/auth`, or null before the first exchange. */
    val jwt: String? = null,
    /** Epoch ms when [jwt] was obtained, or null. */
    val jwtObtainedAtMs: Long? = null,
    /** Identity from a successful auth response, retained when the cached JWT is cleared. */
    val namespace: String? = null,
) {
    /** Legacy records may still have the identity only in the cached JWT. */
    val pairedNamespace: String? get() = namespace ?: jwt?.let { JwtPeek.peek(it)?.ns }

    fun withJwt(token: String?, obtainedAtMs: Long?): HubCredentials = copy(
        jwt = token,
        jwtObtainedAtMs = obtainedAtMs,
        namespace = token?.let { JwtPeek.peek(it)?.ns } ?: pairedNamespace,
    )

    /**
     * The durable secret this entry authenticates with: the access token when
     * both exist (pairing is the user's explicit, revocable choice; its 401 also
     * tells the UI to re-pair), else the passkey session.
     */
    val authRequest: AuthRequest?
        get() = when {
            accessToken != null -> AuthRequest(accessToken = accessToken)
            passkeySession != null -> AuthRequest(passkeySession = passkeySession)
            else -> null
        }

    /** The secret string matched against a remembered rejected credential. */
    val secret: String? get() = accessToken ?: passkeySession

    /** True while this entry can still exchange for a JWT. */
    val hasCredential: Boolean get() = secret != null

    /** Only signed in by passkey (no access token): 401 means sign in again. */
    val passkeyOnly: Boolean get() = accessToken == null && passkeySession != null
}

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
    /** Namespace of the current record, including JWT refreshes made by another session. */
    fun observeNamespace(hubUrl: String): Flow<String?>
    fun set(credentials: HubCredentials)
    /** Update the same record atomically; an in-flight JWT refresh must not undo a later pairing/sign-out. */
    fun replace(expected: HubCredentials, updated: HubCredentials): Boolean
    fun delete(hubUrl: String)
}

/** Normalized storage key for [hubUrl]; falls back to the raw string. */
internal fun credentialKey(hubUrl: String): String = HubUrls.normalize(hubUrl) ?: hubUrl

/** Hermetic in-memory [CredentialStore] for tests and previews. */
class InMemoryCredentialStore : CredentialStore {
    private val entries = ConcurrentHashMap<String, HubCredentials>()
    private val changes = CredentialChanges()

    override fun observeNamespace(hubUrl: String): Flow<String?> = changes.observe { get(hubUrl)?.pairedNamespace }

    override fun get(hubUrl: String): HubCredentials? = entries[credentialKey(hubUrl)]

    override fun set(credentials: HubCredentials) {
        entries[credentialKey(credentials.hubUrl)] = credentials
        changes.invalidate()
    }

    override fun replace(expected: HubCredentials, updated: HubCredentials): Boolean =
        entries.replace(credentialKey(expected.hubUrl), expected, updated).also { if (it) changes.invalidate() }

    override fun delete(hubUrl: String) {
        entries.remove(credentialKey(hubUrl))
        changes.invalidate()
    }
}

/** Replay an invalidation, not a credential. Collect off the main thread, like [CredentialStore.get]. */
internal class CredentialChanges {
    private val revision = MutableStateFlow(0L)

    fun observe(readNamespace: () -> String?): Flow<String?> = revision.map { readNamespace() }.distinctUntilChanged()

    fun invalidate() = revision.update { it + 1 }
}
