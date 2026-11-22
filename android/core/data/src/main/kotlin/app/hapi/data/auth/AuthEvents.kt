package app.hapi.data.auth

/** Why silent re-auth for a hub gave up for good. */
enum class AuthTerminalReason {
    /** `POST /api/auth` answered 401 — the access token was rotated/revoked. */
    ACCESS_TOKEN_REJECTED,

    /**
     * `POST /api/auth` answered 401 `passkey_session_invalid` — the passkey
     * was deleted, `CLI_API_TOKEN` rotated, or the session expired. Sign in
     * with a passkey (or the access token) again.
     */
    PASSKEY_SESSION_INVALID,

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
