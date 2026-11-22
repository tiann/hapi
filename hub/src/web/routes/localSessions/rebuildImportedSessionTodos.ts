import type { Store } from '../../../store'
import { SessionCache } from '../../../sync/sessionCache'
import type { EventPublisher } from '../../../sync/eventPublisher'
import type { SyncEngine } from '../../../sync/syncEngine'

/** Direct transcript writes bypass the live socket task extractor. */
export function rebuildImportedSessionTodos(store: Store, engine: SyncEngine | null, sessionId: string): void {
    if (engine?.rebuildSessionTodos) {
        engine.rebuildSessionTodos(sessionId, { touchUpdatedAt: false })
        return
    }
    const cache = new SessionCache(store, { emit: () => {} } as unknown as EventPublisher)
    cache.rebuildTodosFromTranscript(sessionId, { touchUpdatedAt: false })
}
