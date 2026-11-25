package app.hapi.companion.di

import android.content.Context
import app.hapi.companion.feature.chat.composer.ChatDrafts
import app.hapi.companion.feature.chat.composer.DataStoreRecentSkills
import app.hapi.companion.feature.chat.composer.RecentSkills
import app.hapi.companion.feature.home.ConnectionChrome
import app.hapi.companion.feature.home.RunnerSkewChrome
import app.hapi.data.HubSession
import app.hapi.data.auth.AuthEvents
import app.hapi.data.auth.CredentialStore
import app.hapi.data.auth.JwtPeek
import app.hapi.data.sse.GlobalSsePipe
import app.hapi.data.sse.AndroidNetworkMonitor
import app.hapi.data.sse.OkHttpSseTransport
import app.hapi.data.sse.SseEngine
import app.hapi.data.sse.SseSubscriptionKey
import app.hapi.data.sse.SseTokenProvider
import app.hapi.data.sse.SyncEventRouter
import app.hapi.data.sse.SyncTargets
import app.hapi.data.sse.VisibilityReporter
import app.hapi.data.store.LastSeenStore
import app.hapi.data.store.MachineStore
import app.hapi.data.store.MessageWindowStores
import app.hapi.data.store.ScratchlistStore
import app.hapi.data.store.SessionStore
import app.hapi.data.store.StoreSyncTargets
import app.hapi.data.store.WindowSnapshots
import app.hapi.protocol.wire.SyncEvent
import coil.ImageLoader
import java.io.Closeable
import java.io.File
import java.security.MessageDigest
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf

/**
 * Everything scoped to the **active** hub. [AppGraph] creates one per
 * active-hub change (observing `HubRegistry.state`) and [close]s the previous
 * one — nothing here survives a hub switch.
 *
 * Wiring: [HubSession] (REST + silent re-auth, from `:core:data`) → its
 * `ensureFreshToken` adapts to the [SseEngine]'s token provider (SSE
 * authenticates only at connect time) → [SyncEventRouter] fans engine events
 * out to [StoreSyncTargets], which feeds the per-hub stores below. Screens
 * own the actual SSE subscriptions (session list = global pipe, open chat =
 * its session pipe), all against this one engine.
 */
class HubGraph(
    hubUrl: String,
    credentialStore: CredentialStore,
    authEvents: AuthEvents,
    /** Application context: Coil loader + cache/files roots derive from it. */
    context: Context,
) : Closeable {

    /** ViewModels must not retain a closed graph after a same-origin replacement. */
    internal val instanceId = UUID.randomUUID().toString()

    /** Child of nothing on purpose: cancelled explicitly in [close]. */
    val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    val session: HubSession = HubSession(
        hubUrl = hubUrl,
        credentialStore = credentialStore,
        authEvents = authEvents,
        imageCacheDir = File(File(context.cacheDir, "hub-images"), dirNameFor(hubUrl)),
    )

    /** Normalized origin (via [HubSession]'s own normalization). */
    val hubUrl: String get() = session.hubUrl

    val sseEngine: SseEngine = SseEngine(
        baseUrl = session.hubUrl,
        transport = OkHttpSseTransport(),
        tokenProvider = SessionTokenProvider(session),
        scope = scope,
    )

    private val networkMonitor = AndroidNetworkMonitor(context, sseEngine::networkChanged)

    private val initialNamespace = credentialStore.get(session.hubUrl)?.pairedNamespace
    @Volatile internal var pairedNamespace = initialNamespace
        private set

    // Legacy URL-only snapshots have no reliable owner. Never read them, and
    // do not open disk snapshots until this graph has an identified namespace.
    private fun snapshotDir(context: Context, namespace: String): File {
        val digest = MessageDigest.getInstance("SHA-256").digest("${session.hubUrl}\u0000$namespace".encodeToByteArray())
        return File(File(context.filesDir, "hub-snapshots"), digest.joinToString("") { "%02x".format(it) })
    }

    private val snapshotDir = initialNamespace?.let { snapshotDir(context, it) }

    val sessionStore: SessionStore = SessionStore(session.api, scope, snapshotDir)

    /**
     * Per-session scratchlist cache (B-M4d), refetched when a session patch
     * carries the `scratchlistUpdatedAt` trigger.
     */
    val scratchlistStore: ScratchlistStore = ScratchlistStore(
        api = session.api,
        scope = scope,
        invalidations = sessionStore.scratchlistInvalidations,
    )

    val machineStore: MachineStore = MachineStore(session.api, scope, snapshotDir)

    // Read state already namespaces its own files, so keep its existing location.
    val lastSeenStore: LastSeenStore = LastSeenStore(
        scope, File(File(context.filesDir, "hubs"), dirNameFor(session.hubUrl)), namespace = pairedNamespace,
    )

    private fun configureReadState() {
        scope.launch {
            val namespace = pairedNamespace ?: runCatching { session.ensureFreshToken()?.let { JwtPeek.peek(it)?.ns } }.getOrNull()
                ?: return@launch
            lastSeenStore.configure(namespace) { id, state ->
                check(session.ensureFreshToken()?.let { JwtPeek.peek(it)?.ns } == namespace) { "Read state identity changed" }
                session.api.updateSessionReadState(id, state).readState
            }
        }
    }

    init { configureReadState() }

    val messageWindows: MessageWindowStores = MessageWindowStores(
        api = session.api,
        scope = scope,
        snapshots = snapshotDir?.let { WindowSnapshots(File(it, "windows")) },
        historyRetentionLimit = app.hapi.protocol.window.OLDER_LOAD_WINDOW_SIZE,
    )

    private val mutableToasts = MutableSharedFlow<SyncEvent.Toast>(extraBufferCapacity = 16)

    /** Hub-pushed in-app banners (never replayed); UI consumption lands in M4/M5. */
    val toasts: SharedFlow<SyncEvent.Toast> = mutableToasts.asSharedFlow()

    /** `POST /api/visibility` reporting, fed subscription ids by the handshake hook. */
    val visibilityReporter: VisibilityReporter =
        VisibilityReporter(session.api::setVisibility, scope)

    /**
     * Global connection banner state (slice C-①): reconnecting/syncing notice
     * from the global pipe + the resync lifecycle. Lives before
     * [syncTargets] so its synchronous `onResyncEvent` hook can feed it.
     */
    val connectionChrome: ConnectionChrome =
        ConnectionChrome(
            globalOutageNotice = sseEngine.connectionOutageNotice(SseSubscriptionKey.Global),
            scope = scope,
        )

    /**
     * Runner version-skew banner state (slice C-②): machines missing required
     * capabilities + the manual restart exit.
     */
    val runnerSkewChrome: RunnerSkewChrome =
        RunnerSkewChrome(
            machines = machineStore.machines,
            restartRunner = { machineId -> session.api.restartMachineRunner(machineId) },
            scope = scope,
        )

    val syncTargets: SyncTargets = StoreSyncTargets(
        sessions = sessionStore,
        machines = machineStore,
        scope = scope,
        messageWindows = messageWindows,
        onToastEvent = { mutableToasts.tryEmit(it) },
        onHandshakeEvent = visibilityReporter::onHandshake,
        onResyncEvent = connectionChrome::onResyncEvent,
    )

    val syncEventRouter: SyncEventRouter = SyncEventRouter(syncTargets)

    /**
     * Hub-lifetime owner of the global SSE subscription (dual-subscription
     * model): queued/consumed bookkeeping and list badges stay fresh no
     * matter which screen is open. Torn down with [scope] on [close].
     */
    val globalPipe: GlobalSsePipe = GlobalSsePipe(sseEngine, syncTargets, scope).also { it.start() }

    /**
     * Process foreground/background: defer/release SSE retries and report
     * visibility to the hub (push suppression). Driven by `AppGraph` from
     * `ProcessLifecycleOwner`.
     */
    fun setLifecycleForeground(foreground: Boolean) {
        sseEngine.setLifecycleForeground(foreground)
        visibilityReporter.setForeground(foreground)
        lastSeenStore.setForeground(foreground)
        if (foreground) configureReadState()
    }

    /**
     * Loads `/api/sessions/:id/generated-images/:imageId` (and any other hub
     * URL) through the authed image client: JWT interceptor + silent 401
     * re-auth + the per-hub 256 MB disk cache (images are immutable + ETagged).
     */
    val imageLoader: ImageLoader = ImageLoader.Builder(context)
        .okHttpClient(session.imageClient)
        .build()

    /** Absolute URL of a generated image, for [imageLoader]. */
    fun generatedImageUrl(sessionId: String, imageId: String): String =
        "${session.hubUrl}/api/sessions/$sessionId/generated-images/$imageId"

    /** Absolute URL of a scratchlist attachment's raw bytes, for [imageLoader]. */
    fun scratchlistAttachmentUrl(sessionId: String, attachmentId: String): String =
        "${session.hubUrl}/api/sessions/$sessionId/scratchlist/attachments/$attachmentId"

    /** Per-session composer drafts, keyed under this hub (process-wide DataStore). */
    val chatDrafts: ChatDrafts = DataStoreChatDrafts(context.chatDraftsDataStore, hubKey = session.hubUrl)

    private val skillHistory = MutableStateFlow(initialNamespace?.let { DataStoreRecentSkills(context.hapiDataStore, session.hubUrl, it) })

    // Keep the source held by an open chat, even if its namespace is still unknown.
    val recentSkills: RecentSkills = object : RecentSkills {
        @OptIn(ExperimentalCoroutinesApi::class)
        override val names: Flow<List<String>> = skillHistory.flatMapLatest { it?.names ?: flowOf(emptyList()) }

        override suspend fun record(name: String) {
            // A successful skills request can precede the storage binding.
            skillHistory.filterNotNull().first().record(name)
        }
    }

    init {
        if (initialNamespace == null) scope.launch(Dispatchers.IO) {
            // A push worker can refresh before this graph's own authenticator.
            // Bind once from the shared record, without replacing clients or view models.
            val namespace = credentialStore.observeNamespace(session.hubUrl).filterNotNull().first()
            val dir = snapshotDir(context, namespace)
            sessionStore.enableSnapshots(dir)
            machineStore.enableSnapshots(dir)
            messageWindows.enableSnapshots(WindowSnapshots(File(dir, "windows")))
            pairedNamespace = namespace
            skillHistory.value = DataStoreRecentSkills(context.hapiDataStore, session.hubUrl, namespace)
            configureReadState()
        }
    }

    override fun close() {
        networkMonitor.close()
        lastSeenStore.shutdown()
        scope.cancel()
        imageLoader.shutdown()
        session.close()
    }

    private companion object {
        /**
         * Filesystem-safe per-hub directory name. Distinct hubs must map to
         * distinct directories (OkHttp caches require exclusive dirs);
         * origins differing only in `[^A-Za-z0-9._-]` characters cannot
         * collide because those are exactly `://` and `:`.
         */
        fun dirNameFor(hubUrl: String): String =
            hubUrl.replace(Regex("[^A-Za-z0-9._-]"), "_")
    }
}

/** SSE 401s invalidate the cached JWT, not the durable pairing identity. */
private class SessionTokenProvider(private val session: HubSession) : SseTokenProvider {
    override suspend fun freshToken(forceRefresh: Boolean): String? =
        session.authenticator.ensureFreshToken(forceRefresh)
}
