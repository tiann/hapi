package app.hapi.data.push

import app.hapi.data.HubSession
import app.hapi.data.api.HapiApi
import app.hapi.data.auth.AuthEvents
import app.hapi.data.auth.CredentialStore
import app.hapi.data.auth.HubRegistry

/**
 * Authenticated per-hub API access for background push work (FCM service,
 * WorkManager workers). The UI-side `HubGraph` only exists for the *active*
 * hub and may not exist at all in a background process — so this constructs a
 * throwaway [HubSession] from the stored credentials on demand instead:
 * `TokenAuthenticator` reuses the persisted JWT and silently re-exchanges the
 * access token on 401, exactly like the foreground client.
 *
 * Sessions are opened per call and closed immediately; push actions are rare
 * enough that connection reuse is irrelevant.
 */
class PushHubAccess internal constructor(
    val registry: HubRegistry,
    private val sessionFactory: (String) -> HubSession,
) {
    constructor(
        registry: HubRegistry,
        credentialStore: CredentialStore,
        authEvents: AuthEvents? = null,
    ) : this(
        registry = registry,
        sessionFactory = { hubUrl ->
            HubSession(
                hubUrl = hubUrl,
                credentialStore = credentialStore,
                authEvents = authEvents,
            )
        },
    )

    /**
     * Paired hub origins with the active hub first — the try-order for
     * hub-resolving push actions (see [PushActionRunner]): the FCM payload
     * carries no hub URL, and for the overwhelmingly common single-hub setup
     * the first try is the only try.
     */
    fun pairedHubsActiveFirst(): List<String> {
        val state = registry.state.value
        val active = state.activeHubUrl
        return if (active == null) state.hubs
        else listOf(active) + state.hubs.filter { it != active }
    }

    /** Runs [block] against a freshly constructed authed client for [hubUrl]. */
    suspend fun <T> withApi(hubUrl: String, block: suspend (HapiApi) -> T): T {
        val session = sessionFactory(hubUrl)
        return try {
            block(session.api)
        } finally {
            session.close()
        }
    }
}
