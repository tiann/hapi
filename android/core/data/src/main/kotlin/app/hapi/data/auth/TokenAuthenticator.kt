package app.hapi.data.auth

import app.hapi.protocol.wire.AuthResponse
import app.hapi.protocol.wire.HapiJson
import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import okhttp3.Authenticator
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.Route

/**
 * Silent re-auth for one hub (`docs/api/client-contract/auth.md#silent-re-auth-401-handling`).
 *
 * The JWT expires every 4 hours, so 401s are routine. As an OkHttp
 * [Authenticator] this reacts to any middleware 401 by re-exchanging the
 * stored credential (`POST /api/auth`) and retrying the request **exactly
 * once**. The refresh is single-flighted through a [Mutex]:
 *
 * - If, once inside the lock, the current JWT already differs from the one the
 *   failed request carried, another caller refreshed meanwhile — retry with
 *   the current JWT, no extra exchange.
 * - Otherwise exchange synchronously (we are on an OkHttp worker thread),
 *   persist the new JWT into the [CredentialStore], and retry.
 * - A response that already has a [Response.priorResponse] is the retry
 *   itself failing again → give up and emit [AuthTerminalReason.RETRY_EXHAUSTED].
 * - The exchange body carries whichever durable secret the entry has — the
 *   access token or, for passkey sign-ins, the passkey session — so the same
 *   loop serves both sign-in paths.
 * - A 401 from `POST /api/auth` means that secret was rotated/revoked →
 *   emit [AuthTerminalReason.ACCESS_TOKEN_REJECTED] (access token) or
 *   [AuthTerminalReason.PASSKEY_SESSION_INVALID] (`passkey_session_invalid`),
 *   both asking the user to sign in again; the rejected secret is remembered
 *   so concurrent/subsequent failures don't storm the endpoint (a new pairing
 *   or passkey sign-in storing a *different* secret clears the block).
 * - Transient exchange failures (I/O, 5xx) fail the call without a terminal
 *   event: the original 401 surfaces and the caller may retry later.
 *
 * [ensureFreshToken] is the proactive path: SSE connects authenticate once at
 * connect time, so the engine calls it pre-connect to avoid streaming on a
 * token that dies mid-stream.
 */
class TokenAuthenticator(
    hubUrl: String,
    private val credentialStore: CredentialStore,
    /** Undecorated client (no [AuthInterceptor]/authenticator) for `POST /api/auth`. */
    private val authClient: OkHttpClient,
    private val authEvents: AuthEvents? = null,
    private val nowMs: () -> Long = System::currentTimeMillis,
) : Authenticator {

    private val hubUrl: String = HubUrls.normalize(hubUrl) ?: hubUrl
    private val authUrl = this.hubUrl.toHttpUrl().newBuilder()
        .addPathSegment("api").addPathSegment("auth").build()

    private val mutex = Mutex()

    @Volatile
    private var cachedJwt: String? = null

    /** Durable secret (access token or passkey session) the hub already refused. */
    @Volatile
    private var rejectedSecret: String? = null

    /** The JWT requests should carry right now (memory first, then store). */
    fun currentJwt(): String? {
        cachedJwt?.let { return it }
        val stored = credentialStore.get(hubUrl)?.jwt
        if (stored != null) cachedJwt = stored
        return stored
    }

    override fun authenticate(route: Route?, response: Response): Request? {
        if (response.priorResponse != null) {
            // Second 401 for this call: the freshly-exchanged JWT was rejected too.
            authEvents?.onAuthTerminal(hubUrl, AuthTerminalReason.RETRY_EXHAUSTED)
            return null
        }
        val failedJwt = response.request.header("Authorization")
            ?.removePrefix("Bearer ")?.trim()
        val fresh = runBlocking { refresh(failedJwt) } ?: return null
        return response.request.newBuilder()
            .header("Authorization", "Bearer $fresh")
            .build()
    }

    /**
     * Proactively refreshes when the JWT is missing, undecodable, or expires
     * within [FRESH_WINDOW_MS] (10 min). If SSE rejected the current JWT,
     * clear both JWT caches but retain the durable pairing identity.
     */
    suspend fun ensureFreshToken(forceRefresh: Boolean = false): String? {
        if (!forceRefresh) currentJwt()?.takeIf { !isStale(it) }?.let { return it }
        return withContext(Dispatchers.IO) {
            mutex.withLock {
                if (forceRefresh) {
                    val credentials = credentialStore.get(hubUrl)
                    if (credentials?.jwt != null && !credentialStore.replace(credentials, credentials.withJwt(null, null))) {
                        return@withLock null
                    }
                    cachedJwt = null
                    exchangeLocked()
                } else {
                    currentJwt()?.takeIf { !isStale(it) } ?: exchangeLocked()
                }
            }
        }
    }

    private fun isStale(jwt: String): Boolean {
        // Undecodable/exp-less tokens count as stale: refresh rather than let
        // the (4h-lived per contract) token die mid-use.
        val expiresAtMs = JwtPeek.expiresAtMs(jwt) ?: return true
        return expiresAtMs - nowMs() < FRESH_WINDOW_MS
    }

    private suspend fun refresh(failedJwt: String?): String? = mutex.withLock {
        val current = currentJwt()
        if (current != null && current != failedJwt) current else exchangeLocked()
    }

    /** Blocking `POST /api/auth`; call only while holding [mutex], off the main thread. */
    private fun exchangeLocked(): String? {
        val credentials = credentialStore.get(hubUrl) ?: run {
            authEvents?.onAuthTerminal(hubUrl, AuthTerminalReason.MISSING_CREDENTIALS)
            return null
        }
        val authRequest = credentials.authRequest ?: run {
            authEvents?.onAuthTerminal(hubUrl, AuthTerminalReason.MISSING_CREDENTIALS)
            return null
        }
        if (credentials.secret == rejectedSecret) return null

        val body = HapiJson.encodeToString(authRequest).toRequestBody(JSON_MEDIA_TYPE)
        val response = try {
            authClient.newCall(Request.Builder().url(authUrl).post(body).build()).execute()
        } catch (_: IOException) {
            return null // transient: no terminal event
        }
        response.use {
            val text = it.body?.string().orEmpty()
            if (it.code == 401) {
                if (credentialStore.get(hubUrl)?.secret != credentials.secret) return null
                rejectedSecret = credentials.secret
                authEvents?.onAuthTerminal(hubUrl, terminalReason(credentials))
                return null
            }
            if (!it.isSuccessful) return null // transient (5xx): no terminal event
            val auth = try {
                HapiJson.decodeFromString<AuthResponse>(text)
            } catch (_: Exception) {
                return null
            }
            val updated = credentials.withJwt(auth.token, nowMs())
            if (!credentialStore.replace(credentials, updated)) return null
            rejectedSecret = null
            cachedJwt = auth.token
            return auth.token
        }
    }

    /**
     * `passkey_session_invalid` (or any `/api/auth` 401 on a passkey-only
     * entry) means the passkey was deleted, its `CLI_API_TOKEN` rotated, or
     * the session expired → sign in again; the access-token path keeps its
     * historical reason (re-pair).
     */
    private fun terminalReason(credentials: HubCredentials): AuthTerminalReason =
        if (credentials.passkeyOnly) {
            AuthTerminalReason.PASSKEY_SESSION_INVALID
        } else {
            AuthTerminalReason.ACCESS_TOKEN_REJECTED
        }

    companion object {
        /** Refresh proactively when less than this much lifetime remains. */
        const val FRESH_WINDOW_MS: Long = 10 * 60 * 1000
        private val JSON_MEDIA_TYPE = "application/json".toMediaType()
    }
}
