import type { Store } from '../../../store'
import { SessionCache } from '../../../sync/sessionCache'
import type { EventPublisher } from '../../../sync/eventPublisher'
import type { SyncEngine } from '../../../sync/syncEngine'
import { findLatestStructuredTodos } from '../../../sync/todos'

/** Direct transcript writes bypass the live socket task extractor. */
export function rebuildImportedSessionTodos(store: Store, engine: SyncEngine | null, sessionId: string): void {
    if (engine?.rebuildSessionTodos) {
        engine.rebuildSessionTodos(sessionId, { touchUpdatedAt: false })
        return
    }
    const cache = new SessionCache(store, { emit: () => {} } as unknown as EventPublisher)
    cache.rebuildTodosFromTranscript(sessionId, { touchUpdatedAt: false })
}

/** Inside the transcript import transaction, before publishing cache events. */
export function persistImportedSessionTodos(store: Store, sessionId: string, namespace: string): void {
    const latest = findLatestStructuredTodos(store, sessionId)
    if (!latest) return
    const session = store.sessions.getSessionByNamespace(sessionId, namespace)
    if (session && JSON.stringify(session.todos) === JSON.stringify(latest.todos)
        && session.todosSourceAt === latest.source.at && session.todosSourceSeq === latest.source.seq) return
    if (!store.sessions.replaceSessionTodos(sessionId, latest.todos, namespace, latest.source, { touchUpdatedAt: false })) {
        throw new Error('Failed to persist imported session tasks')
    }
}
