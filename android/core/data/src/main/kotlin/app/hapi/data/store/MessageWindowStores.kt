package app.hapi.data.store

import app.hapi.data.api.MessagesApi
import app.hapi.protocol.window.MessageWindowLogic
import app.hapi.protocol.window.HISTORY_WINDOW_SIZE
import app.hapi.protocol.wire.Session
import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Per-hub registry of per-session [MessageWindowStore]s — the analogue of the
 * web module's session-keyed maps. [open] hydrates a cold session from its
 * disk snapshot (interrupted `sending` rows restore, stale snapshots start
 * flagged for a latest reset); [seed] carries a window across a
 * resume/reopen id change. Snapshot files themselves are LRU-capped by
 * [WindowSnapshots].
 */
class MessageWindowStores(
    private val api: MessagesApi,
    private val scope: CoroutineScope,
    snapshots: WindowSnapshots? = null,
    private val historyRetentionLimit: Int = HISTORY_WINDOW_SIZE,
    private val legacySnapshots: WindowSnapshots? = null,
    snapshotNamespace: String? = null,
) {
    private val mutex = Mutex()
    private var snapshots = snapshots
    private val stores = HashMap<String, MessageWindowStore>()
    private val snapshotNamespaceReady = CompletableDeferred<String>().apply {
        if (snapshotNamespace != null) complete(snapshotNamespace)
    }

    /** The session's store, hydrating from its snapshot on first open. */
    suspend fun open(sessionId: String): MessageWindowStore {
        while (true) {
            val snapshots = mutex.withLock {
                stores[sessionId]?.let { return it }
                this.snapshots
            }
            val hydrated = snapshots?.load(sessionId)?.let { MessageWindowLogic.hydrate(sessionId, it) }
            mutex.withLock {
                // Hydrate outside the lock. Retry if a namespace was bound mid-open.
                if (snapshots === this.snapshots) {
                    return stores.getOrPut(sessionId) {
                        MessageWindowStore(
                            sessionId = sessionId,
                            api = api,
                            scope = scope,
                            snapshots = snapshots,
                            initialState = hydrated,
                            historyRetentionLimit = historyRetentionLimit,
                        )
                    }
                }
            }
        }
    }

    /** Late identity recovery must keep the same stores for already-open chats. */
    suspend fun enableSnapshots(snapshots: WindowSnapshots, namespace: String) {
        val open = mutex.withLock {
            if (this.snapshots != null) return
            this.snapshots = snapshots
            stores.values.toList()
        }
        for (store in open) store.enableSnapshots(snapshots)
        snapshotNamespaceReady.complete(namespace)
    }

    /** Call only with detail returned by an authenticated lookup of this exact session. */
    suspend fun recoverLegacyFailedSends(sessionId: String, verified: Session) {
        val legacy = legacySnapshots ?: return
        if (verified.id != sessionId || verified.namespace != snapshotNamespaceReady.await()) return
        try {
            open(sessionId).recoverLegacyFailedSends(legacy)
        } catch (_: IOException) {
            // The old file stays intact; retry on the next verified open.
        }
    }

    /** Already-open store, if any (no hydration). */
    suspend fun peek(sessionId: String): MessageWindowStore? =
        mutex.withLock { stores[sessionId] }

    /** Web `seedMessageWindowFromSession` for resume/reopen id migration. */
    suspend fun seed(fromSessionId: String, toSessionId: String) {
        if (fromSessionId.isEmpty() || toSessionId.isEmpty() || fromSessionId == toSessionId) return
        val source = open(fromSessionId)
        val target = open(toSessionId)
        target.seedFrom(source)
    }

    /** Web `clearMessageWindow` (e.g. on `session-removed`). */
    suspend fun clear(sessionId: String) {
        mutex.withLock { stores[sessionId] }?.clear()
    }
}
