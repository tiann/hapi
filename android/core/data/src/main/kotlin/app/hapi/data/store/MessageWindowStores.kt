package app.hapi.data.store

import app.hapi.data.api.MessagesApi
import app.hapi.protocol.window.MessageWindowLogic
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
    private val snapshots: WindowSnapshots? = null,
) {
    private val mutex = Mutex()
    private val stores = HashMap<String, MessageWindowStore>()

    /** The session's store, hydrating from its snapshot on first open. */
    suspend fun open(sessionId: String): MessageWindowStore {
        mutex.withLock { stores[sessionId] }?.let { return it }
        // Hydrate outside the lock (disk I/O), then race-tolerantly install.
        val hydrated = snapshots?.load(sessionId)?.let { MessageWindowLogic.hydrate(sessionId, it) }
        return mutex.withLock {
            stores.getOrPut(sessionId) {
                MessageWindowStore(
                    sessionId = sessionId,
                    api = api,
                    scope = scope,
                    snapshots = snapshots,
                    initialState = hydrated,
                )
            }
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
