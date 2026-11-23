import type { QueryClient } from '@tanstack/react-query'
import type { Session, SessionPatch } from '@/types/api'

// A fetch may begin with no detail cache, or with exactly the value a later
// expiry reaffirms. Observe the wire event, not a change of cache identity.
const keys = ['active', 'activeAt', 'thinking', 'thinkingAt', 'activeTurnStartedAt',
    'backgroundTaskCount', 'backgroundTasks', 'derivedToolWork'] as const
type LivePatch = Partial<Pick<Session, typeof keys[number]>>
type Observer = (patch: LivePatch) => void
const pending = new WeakMap<QueryClient, Map<string, Set<Observer>>>()

export function observeSessionDetail(client: QueryClient, id: string, patch: SessionPatch | Session): void {
    pending.get(client)?.get(id)?.forEach(observe => observe(patch))
}

export async function readSessionWithLiveUpdates<T extends { session: Session }>(client: QueryClient, id: string, read: () => Promise<T>): Promise<T> {
    const sessions = pending.get(client) ?? new Map<string, Set<Observer>>()
    pending.set(client, sessions)
    const observers = sessions.get(id) ?? new Set<Observer>()
    sessions.set(id, observers)
    // Bounded to one observation per field, even across a very slow request.
    const seen = new Map<typeof keys[number], { at?: number; fields: LivePatch }>()
    const observe: Observer = patch => {
        for (const key of keys) {
            const value = patch[key]
            if (value === undefined) continue
            const at = patch.activeAt
            const previous = seen.get(key)?.at
            if (at !== undefined && previous !== undefined && at < previous) continue
            seen.set(key, { at, fields: { [key]: value } })
        }
    }
    observers.add(observe)
    try {
        let result = await read()
        const live = seen.get('active')
        // Expiry and its preceding keepalive deliberately share the Hub clock.
        // Refetch *after* seeing both contradictory observations; the answer no
        // longer depends on which stream was delayed. Bound this to one retry.
        if (live && live.at === result.session.activeAt && live.fields.active !== result.session.active) {
            seen.clear()
            result = await read()
        }
        if (!seen.size) return result
        const session = { ...result.session }
        const repeated = seen.get('active')
        // If the exact tie recurs during verification, retain a confirmed stop
        // over an indistinguishable replayed keepalive until a fresh connect.
        if (!session.active && repeated?.at === session.activeAt && repeated?.fields.active === true) return result
        for (const { at, fields } of seen.values()) {
            if (at === undefined || at >= result.session.activeAt) Object.assign(session, fields)
        }
        // A queued-turn or tool update may carry no presence clock. It cannot
        // reopen a turn after expiry; only an observed reconnect can do that.
        if (!session.active && !result.session.active) {
            return { ...result, session: { ...result.session, activeAt: session.activeAt } }
        }
        if (!session.active) {
            session.thinking = false
            session.activeTurnStartedAt = null
            session.backgroundTaskCount = 0
            session.backgroundTasks = []
            session.derivedToolWork = false
        }
        return { ...result, session }
    } finally {
        observers.delete(observe)
        if (!observers.size) sessions.delete(id)
    }
}
