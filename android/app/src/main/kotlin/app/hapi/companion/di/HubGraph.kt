package app.hapi.companion.di

import android.content.Context
import app.hapi.companion.feature.chat.composer.ChatDrafts
import app.hapi.data.HubSession
import app.hapi.data.auth.AuthEvents
import app.hapi.data.auth.CredentialStore
import app.hapi.data.sse.GlobalSsePipe
import app.hapi.data.sse.OkHttpSseTransport
import app.hapi.data.sse.SseEngine
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
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.withContext

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
        tokenProvider = SessionTokenProvider(session, credentialStore),
        scope = scope,
    )

    /** Per-hub snapshot root (filesDir — survives cache pressure). */
    private val snapshotDir: File = File(File(context.filesDir, "hubs"), dirNameFor(session.hubUrl))

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

    val lastSeenStore: LastSeenStore = LastSeenStore(scope, snapshotDir)

    val messageWindows: MessageWindowStores = MessageWindowStores(
        api = session.api,
        scope = scope,
        snapshots = WindowSnapshots(File(snapshotDir, "windows")),
    )

    private val mutableToasts = MutableSharedFlow<SyncEvent.Toast>(extraBufferCapacity = 16)

    /** Hub-pushed in-app banners (never replayed); UI consumption lands in M4/M5. */
    val toasts: SharedFlow<SyncEvent.Toast> = mutableToasts.asSharedFlow()

    /** `POST /api/visibility` reporting, fed subscription ids by the handshake hook. */
    val visibilityReporter: VisibilityReporter =
        VisibilityReporter(session.api::setVisibility, scope)

    val syncTargets: SyncTargets = StoreSyncTargets(
        sessions = sessionStore,
        machines = machineStore,
        scope = scope,
        messageWindows = messageWindows,
        onToastEvent = { mutableToasts.tryEmit(it) },
        onHandshakeEvent = visibilityReporter::onHandshake,
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

    override fun close() {
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

/**
 * Adapts [HubSession.ensureFreshToken] to the engine's [SseTokenProvider].
 *
 * `forceRefresh` (the hub just 401'd the previous token) drops both JWT
 * caches — the persisted copy and the authenticator's in-memory one — so
 * `ensureFreshToken` has to do a genuine `POST /api/auth` exchange instead of
 * returning a token the hub already rejected (rotated jwt-secret, clock skew).
 */
class SessionTokenProvider(
    private val session: HubSession,
    private val credentialStore: CredentialStore,
) : SseTokenProvider {

    override suspend fun freshToken(forceRefresh: Boolean): String? {
        if (forceRefresh) {
            withContext(Dispatchers.IO) {
                credentialStore.get(session.hubUrl)?.let { credentials ->
                    credentialStore.set(credentials.copy(jwt = null, jwtObtainedAtMs = null))
                }
            }
            session.authenticator.clearCachedJwt()
        }
        return session.ensureFreshToken()
    }
}
