package app.hapi.data.auth

/** Why silent re-auth for a hub gave up for good. */
enum class AuthTerminalReason {
    /** `POST /api/auth` answered 401 — the access token was rotated/revoked. */
    ACCESS_TOKEN_REJECTED,

    /** The retried request 401'd again with a freshly-exchanged JWT. */
    RETRY_EXHAUSTED,

    /** No stored credentials for this hub (deleted mid-flight / never paired). */
    MISSING_CREDENTIALS,
}

/**
 * Terminal auth notifications. Fired (possibly from an OkHttp worker thread)
 * when the silent re-auth loop concludes the hub requires **re-pairing** —
 * per contract, transient failures (network, 5xx) never fire this
 * (`docs/api/client-contract/auth.md#silent-re-auth-401-handling`).
 */
fun interface AuthEvents {
    fun onAuthTerminal(hubUrl: String, reason: AuthTerminalReason)
}
