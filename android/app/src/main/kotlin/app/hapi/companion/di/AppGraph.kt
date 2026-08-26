package app.hapi.companion.di

import android.content.Context
import androidx.datastore.preferences.preferencesDataStore
import app.hapi.companion.fcm.RegisterDeviceWorker
import app.hapi.companion.feature.newsession.DataStoreNewSessionPrefs
import app.hapi.companion.feature.newsession.NewSessionPrefs
import app.hapi.companion.feature.pairing.PairingClient
import app.hapi.companion.feature.pairing.PairingClientFactory
import app.hapi.companion.feature.settings.AppLanguage
import app.hapi.companion.feature.settings.LanguagePrefs
import app.hapi.companion.feature.settings.ThemePrefs
import app.hapi.companion.push.DataStorePushDeviceIds
import app.hapi.companion.push.PushBinding
import app.hapi.data.api.HapiApi
import app.hapi.data.auth.AuthEvents
import app.hapi.data.auth.AuthTerminalReason
import app.hapi.data.auth.CredentialStore
import app.hapi.data.auth.EncryptedPrefsCredentialStore
import app.hapi.data.auth.HubRegistry
import app.hapi.data.auth.HubRegistryStorage
import app.hapi.data.push.ApiPushDeviceGateway
import app.hapi.data.push.DeviceRegistrar
import app.hapi.data.push.PushActionRunner
import app.hapi.data.push.PushHubAccess
import app.hapi.protocol.pairing.BindLink
import app.hapi.protocol.wire.AuthResponse
import app.hapi.protocol.wire.HapiJson
import app.hapi.protocol.wire.HubHealthResponse
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient

/** One terminal auth failure, re-emitted off OkHttp threads as a flow. */
data class AuthTerminal(
    val hubUrl: String,
    val reason: AuthTerminalReason,
)

/** Process-wide Preferences DataStore (hub roster + future app settings). */
private val Context.hapiDataStore by preferencesDataStore(name = "hapi_prefs")

/**
 * Process-singleton graph, hand-rolled (no Hilt by design — see plan track B).
 * Constructed once in [app.hapi.companion.HapiApp]; Compose reads it via
 * [LocalAppGraph]; per-active-hub types live in [HubGraph], swapped by this
 * class whenever `HubRegistry.state`'s active hub changes.
 *
 * Call [start] right after construction: it loads the persisted roster
 * ([ready] flips true) and then keeps [activeHubGraph] in sync with the
 * registry.
 */
class AppGraph(context: Context) {

    private val appContext = context.applicationContext

    /** App-lifetime scope; nothing here is ever torn down before the process. */
    val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /** The protocol-configured Json (lenient, ignores unknown keys). */
    val json: Json = HapiJson

    val hubRegistryStorage: HubRegistryStorage =
        DataStoreHubRegistryStorage(appContext.hapiDataStore)

    val credentialStore: CredentialStore = EncryptedPrefsCredentialStore(appContext)

    val hubRegistry: HubRegistry = HubRegistry(hubRegistryStorage)

    /**
     * Create-form persistence (last machine / recent paths / draft), app-wide
     * like the web's localStorage twin — machine ids are globally unique, so
     * hub scoping is unnecessary.
     */
    val newSessionPrefs: NewSessionPrefs = DataStoreNewSessionPrefs(appContext.hapiDataStore)

    /** Appearance choice (B-M4e); MainActivity reads it at setContent. */
    val themePrefs: ThemePrefs = ThemePrefs(appContext.hapiDataStore)

    /** Language choice (B-M5a: applied via per-app locales; Settings writes it). */
    val languagePrefs: LanguagePrefs = LanguagePrefs(appContext.hapiDataStore)

    /**
     * Eagerly-cached language for non-composable surfaces (B-M5a): FCM
     * notifications and WorkManager updates resolve strings from the
     * application context, which appcompat's per-app locales do not retarget
     * on API < 33 — they wrap it via `localizedForAppLanguage` instead. May
     * briefly read [AppLanguage.SYSTEM] on a cold process before the first
     * DataStore emission (a system-locale notification once — benign).
     */
    val appLanguage: StateFlow<AppLanguage> = languagePrefs.language
        .stateIn(scope, SharingStarted.Eagerly, AppLanguage.SYSTEM)

    private val mutableAuthTerminals = MutableSharedFlow<AuthTerminal>(extraBufferCapacity = 16)

    /**
     * Terminal auth failures for any hub (re-pair required). Fired by OkHttp
     * worker threads via [authEvents]; navigation collects and routes to the
     * pairing screen with an explanatory banner.
     */
    val authTerminals: SharedFlow<AuthTerminal> = mutableAuthTerminals.asSharedFlow()

    /** The [AuthEvents] sink every [HubSession][app.hapi.data.HubSession] gets. */
    val authEvents: AuthEvents = AuthEvents { hubUrl, reason ->
        mutableAuthTerminals.tryEmit(AuthTerminal(hubUrl, reason))
    }

    /**
     * The most recent unconsumed `hapicompanion://bind` deep link.
     * MainActivity posts (cold start + onNewIntent); the pairing screen
     * consumes and clears.
     */
    val pendingBindLink = MutableStateFlow<BindLink?>(null)

    /**
     * Session id from a tapped push notification, waiting for navigation
     * (the internal intent route — no public URI). MainActivity posts;
     * `HapiNavigation` consumes, clears, and opens the chat.
     */
    val pendingOpenSessionId = MutableStateFlow<String?>(null)

    /**
     * The session id of the currently composed chat screen, or null. Feeds
     * the FCM suppress-when-open rule (`shouldSuppressPush`): while that
     * exact session is on screen in the foreground, the in-app SSE stream
     * already shows the event, so no OS notification is posted for it.
     */
    val openChatSessionId = MutableStateFlow<String?>(null)

    /** One-line banner for the pairing screen ("signed out because …"). */
    val pairingNotice = MutableStateFlow<String?>(null)

    /**
     * Bare client for the two pre-pairing endpoints (`GET /health`,
     * `POST /api/auth`) — no interceptors: there are no credentials yet.
     */
    private val pairingHttpClient: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .build()

    /** Builds the pairing probe for a candidate hub URL (normalized upstream). */
    val pairingClientFactory: PairingClientFactory = PairingClientFactory { hubUrl ->
        val api = HapiApi(hubUrl = hubUrl, client = pairingHttpClient)
        object : PairingClient {
            override suspend fun health(): HubHealthResponse = api.health()
            override suspend fun authenticate(accessToken: String): AuthResponse =
                api.authenticate(accessToken)
        }
    }

    // ------------------------------------------------------------ push (B-M4a) --

    /** Authed per-hub API access for background push work (no HubGraph needed). */
    val pushHubAccess: PushHubAccess = PushHubAccess(hubRegistry, credentialStore, authEvents)

    /** Executes notification actions with active-hub-first resolution. */
    val pushActionRunner: PushActionRunner = PushActionRunner(pushHubAccess)

    /**
     * FCM device registration fan-out: every paired hub gets this install's
     * token (`POST /api/devices/register`), keyed by a DataStore-persisted
     * UUID. All entry points no-op when Firebase isn't configured
     * ([PushBinding.currentToken] returns null).
     */
    val deviceRegistrar: DeviceRegistrar = DeviceRegistrar(
        registry = hubRegistry,
        gateway = ApiPushDeviceGateway(pushHubAccess),
        tokenSource = { PushBinding.currentToken(appContext) },
        deviceIds = DataStorePushDeviceIds(appContext.hapiDataStore),
        retryScheduler = { hubUrl -> RegisterDeviceWorker.enqueueRetry(appContext, hubUrl) },
        scope = scope,
    )

    /** `onNewToken` hook: waits for the roster load, then re-registers everywhere. */
    fun onPushTokenRotated(token: String) {
        scope.launch {
            awaitReady()
            deviceRegistrar.onNewToken(token)
        }
    }

    /** Suspends until the persisted hub roster is loaded (workers, FCM paths). */
    suspend fun awaitReady() {
        ready.first { it }
    }

    // --------------------------------------------------------------------------

    private val mutableActiveHubGraph = MutableStateFlow<HubGraph?>(null)

    /** Per-active-hub graph; null while unpaired. Recreated on hub switch. */
    val activeHubGraph: StateFlow<HubGraph?> = mutableActiveHubGraph.asStateFlow()

    private val mutableReady = MutableStateFlow(false)

    /** False until the persisted hub roster is loaded (gate the first frame). */
    val ready: StateFlow<Boolean> = mutableReady.asStateFlow()

    /** Idempotent-enough for the single Application.onCreate call site. */
    fun start() {
        scope.launch {
            hubRegistry.load()
            mutableReady.value = true
            // Roster is loaded: the registrar's first emission re-registers
            // every persisted hub (cheap upsert), then fresh pairings as added.
            deviceRegistrar.start()
            hubRegistry.state
                .map { it.activeHubUrl }
                .distinctUntilChanged()
                .collect { activeHubUrl -> swapActiveHub(activeHubUrl) }
        }
    }

    /**
     * Removes [hubUrl]'s pairing: FCM registration deleted best-effort (must
     * happen first, while this hub's JWT still works — afterwards nothing
     * could ever authenticate the DELETE), then credentials wiped and the
     * roster entry dropped (the registry auto-activates the next hub, or
     * none). The active [HubGraph] swap follows via the registry observer.
     */
    suspend fun signOut(hubUrl: String) {
        withTimeoutOrNull(UNREGISTER_TIMEOUT_MS) { deviceRegistrar.unregisterHub(hubUrl) }
        withContext(Dispatchers.IO) { credentialStore.delete(hubUrl) }
        hubRegistry.removeHub(hubUrl)
    }

    /** Sequential by construction: only the [start] collector calls this. */
    private fun swapActiveHub(activeHubUrl: String?) {
        mutableActiveHubGraph.value?.close()
        mutableActiveHubGraph.value = activeHubUrl?.let { hubUrl ->
            HubGraph(
                hubUrl = hubUrl,
                credentialStore = credentialStore,
                authEvents = authEvents,
                context = appContext,
            ).also { graph ->
                // A hub activated while backgrounded must not burn retries.
                if (!isForeground) graph.setLifecycleForeground(false)
            }
        }
    }

    @Volatile private var isForeground = true

    /** Current process foreground state (FCM suppress-when-open check). */
    val foreground: Boolean get() = isForeground

    /**
     * Process lifecycle input (`ProcessLifecycleOwner` via `HapiApp`):
     * forwarded to the active hub's SSE engine (retry deferral / stale-socket
     * rebuild) and visibility reporter (`POST /api/visibility`).
     */
    fun setForeground(foreground: Boolean) {
        isForeground = foreground
        mutableActiveHubGraph.value?.setLifecycleForeground(foreground)
    }

    private companion object {
        /**
         * Sign-out unregister is best-effort: bounded so a dead hub cannot
         * hang the sign-out UX. A leaked registration self-heals hub-side
         * (FCM reports the token dead after uninstall / token rotation).
         */
        const val UNREGISTER_TIMEOUT_MS = 5_000L
    }
}
