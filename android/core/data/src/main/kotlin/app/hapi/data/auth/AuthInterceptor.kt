package app.hapi.data.auth

import okhttp3.Interceptor
import okhttp3.Response

/**
 * Adds `Authorization: Bearer <jwt>` to every request on the hub client
 * (`docs/api/client-contract/auth.md#sending-the-token`).
 *
 * No header is added when no JWT is known yet (fresh pairing before the first
 * exchange) — the resulting middleware 401 flows into [TokenAuthenticator],
 * which performs the exchange and retries. Requests that already carry an
 * `Authorization` header (an authenticator retry) pass through untouched.
 */
class AuthInterceptor(private val jwtProvider: () -> String?) : Interceptor {

    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        if (request.header("Authorization") != null) return chain.proceed(request)
        val jwt = jwtProvider() ?: return chain.proceed(request)
        return chain.proceed(
            request.newBuilder().header("Authorization", "Bearer $jwt").build()
        )
    }
}
