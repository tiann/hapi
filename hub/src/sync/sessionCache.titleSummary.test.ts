import { describe, expect, it } from 'bun:test'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store } from '../store'
import type { EventPublisher } from './eventPublisher'
import { SessionCache } from './sessionCache'

function createPublisher(events: SyncEvent[]): EventPublisher {
    return {
        emit: (event: SyncEvent) => events.push(event)
    } as unknown as EventPublisher
}

describe('SessionCache.updateSessionSummary', () => {
    it('preserves metadata.name by default while stamping the generated summary timestamp', async () => {
        const store = new Store(':memory:')
        const cache = new SessionCache(store, createPublisher([]))
        const created = cache.getOrCreateSession(
            'summary-session',
            { path: '/tmp', host: 'localhost', name: 'Manual name' },
            null,
            'default'
        )

        await cache.updateSessionSummary(created.id, 'Generated title')

        const updated = cache.getSession(created.id)
        expect(updated?.metadata?.name).toBe('Manual name')
        expect(updated?.metadata?.summary?.text).toBe('Generated title')
        expect(updated?.metadata?.summary?.updatedAt).toBeGreaterThan(0)

        const stored = store.sessions.getSession(created.id)
        expect(stored?.metadata).toMatchObject({
            name: 'Manual name',
            summary: { text: 'Generated title' }
        })
    })

    it('clears an existing metadata.name when explicitly replacing it with a generated summary', async () => {
        const store = new Store(':memory:')
        const cache = new SessionCache(store, createPublisher([]))
        const created = cache.getOrCreateSession(
            'summary-replace-session',
            { path: '/tmp', host: 'localhost', name: 'Manual name' },
            null,
            'default'
        )

        await cache.updateSessionSummary(created.id, 'Generated title', { clearName: true })

        const updated = cache.getSession(created.id)
        expect(updated?.metadata?.name).toBeUndefined()
        expect(updated?.metadata?.summary?.text).toBe('Generated title')
        expect(store.sessions.getSession(created.id)?.metadata).toMatchObject({
            summary: { text: 'Generated title' }
        })
        expect(store.sessions.getSession(created.id)?.metadata).not.toHaveProperty('name')
    })

    it('clears a whitespace-only metadata.name when explicitly replacing it with a generated summary', async () => {
        const store = new Store(':memory:')
        const cache = new SessionCache(store, createPublisher([]))
        const created = cache.getOrCreateSession(
            'summary-whitespace-name-session',
            { path: '/tmp', host: 'localhost', name: '   ' },
            null,
            'default'
        )

        await cache.updateSessionSummary(created.id, 'Generated title', { clearName: true })

        const updated = cache.getSession(created.id)
        expect(updated?.metadata?.name).toBeUndefined()
        expect(updated?.metadata?.summary?.text).toBe('Generated title')
    })
})
