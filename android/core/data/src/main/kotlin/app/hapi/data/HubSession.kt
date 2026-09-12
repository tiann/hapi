package app.hapi.data

import app.hapi.data.api.HapiApi
import app.hapi.data.auth.AuthEvents
import app.hapi.data.auth.AuthInterceptor
import app.hapi.data.auth.CredentialStore
import app.hapi.data.auth.HubUrls
import app.hapi.data.auth.TokenAuthenticator
import java.io.Closeable
import java.io.File
import java.util.concurrent.TimeUnit
import okhttp3.Cache
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient

/**
 * Everything needed to talk to one paired hub, built from plain constructors
 * (no DI framework — `:app`'s AppGraph instantiates one per hub and swaps on
 * active-hub change).
 *
 * Wiring: a base OkHttp client (timeouts only) → [TokenAuthenticator] does
 * `POST /api/auth` on it → the API client layers `AuthInterceptor` (attach
 * JWT) + the authenticator (silent 401 re-auth) on top → [HapiApi] gets the
 * API client, an image variant with a 256 MB disk [Cache] (the hub's
 * generated images are immutable + ETagged), and the bare client for
 * auth/health. All clients share one dispatcher and connection pool.
 *
 * The SSE engine (B-M1c) plugs in beside [api]: it should call
 * [ensureFreshToken] before (re)connecting, since SSE authenticates only at
 * connect time.
 */
class HubSession internal constructor(
    baseUrl: HttpUrl,
    credentialStore: CredentialStore,
    authEvents: AuthEvents? = null,
    /** Directory for the generated-image disk cache; null disables caching (tests). */
    imageCacheDir: File? = null,
    imageCacheMaxBytes: Long = DEFAULT_IMAGE_CACHE_BYTES,
) : Closeable {
    /** Public production entry point: cleartext hub origins are rejected. */
    constructor(
        hubUrl: String,
        credentialStore: CredentialStore,
        authEvents: AuthEvents? = null,
        imageCacheDir: File? = null,
        imageCacheMaxBytes: Long = DEFAULT_IMAGE_CACHE_BYTES,
    ) : this(
        baseUrl = requireHttpsBaseUrl(hubUrl),
        credentialStore = credentialStore,
        authEvents = authEvents,
        imageCacheDir = imageCacheDir,
        imageCacheMaxBytes = imageCacheMaxBytes,
    )

    private val baseUrl: HttpUrl = baseUrl.newBuilder()
        .encodedPath("/")
        .query(null)
        .fragment(null)
        .build()

    /** Normalized hub origin. */
    val hubUrl: String = this.baseUrl.toString().removeSuffix("/")

    private val baseClient: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(CONNECT_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        // Reads must outlive the hub's 30 s RPC-relay timeout so RPC-wrapped
        // endpoints fail with the hub's JSON envelope, not a client timeout.
        .readTimeout(READ_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .writeTimeout(WRITE_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .build()

    /** Exposed for the SSE engine ([ensureFreshToken]) and sign-out cache clearing. */
    val authenticator: TokenAuthenticator =
        TokenAuthenticator(this.hubUrl, credentialStore, baseClient, authEvents)

    private val apiClient: OkHttpClient = baseClient.newBuilder()
        .addInterceptor(AuthInterceptor(authenticator::currentJwt))
        .authenticator(authenticator)
        .build()

    private val imageCache: Cache? = imageCacheDir?.let { Cache(it, imageCacheMaxBytes) }

    /**
     * Authed client with the generated-image disk cache. Public so `:app` can
     * hand it to an image-loading pipeline (Coil) — `/generated-images/:id`
     * URLs then load with the JWT attached and hit the shared ETag cache.
     */
    val imageClient: OkHttpClient =
        imageCache?.let { apiClient.newBuilder().cache(it).build() } ?: apiClient

    val api: HapiApi = HapiApi(
        baseUrl = baseUrl,
        client = apiClient,
        imageClient = imageClient,
        authClient = baseClient,
    )

    /**
     * Proactively refreshes the JWT when < 10 min of lifetime remains
     * (SSE pre-connect). Returns the JWT to use, or null when refresh failed.
     */
    suspend fun ensureFreshToken(): String? = authenticator.ensureFreshToken()

    /** Cancels in-flight calls and releases pooled resources. */
    override fun close() {
        baseClient.dispatcher.cancelAll()
        baseClient.dispatcher.executorService.shutdown()
        baseClient.connectionPool.evictAll()
        imageCache?.close()
    }

    companion object {
        /** 256 MB, per the generated-image caching guidance in rest.md. */
        const val DEFAULT_IMAGE_CACHE_BYTES: Long = 256L * 1024 * 1024
        private const val CONNECT_TIMEOUT_SECONDS = 10L
        private const val READ_TIMEOUT_SECONDS = 60L
        private const val WRITE_TIMEOUT_SECONDS = 60L

        private fun requireHttpsBaseUrl(raw: String): HttpUrl = HubUrls.normalize(raw)
            ?.toHttpUrl()
            ?: throw IllegalArgumentException("Invalid HTTPS hub URL: $raw")
    }
}
