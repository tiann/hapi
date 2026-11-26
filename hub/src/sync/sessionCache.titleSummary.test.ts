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
    it('preserves metadata.name while stamping the generated summary timestamp', async () => {
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
})

describe('SessionCache.setSessionTranslateInput', () => {
    it('turns the toggle on and off, keeping other metadata and publishing updates', async () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))
        const created = cache.getOrCreateSession(
            'translate-session',
            { path: '/tmp', host: 'localhost', name: 'Manual name' },
            null,
            'default'
        )

        await cache.setSessionTranslateInput(created.id, true)
        expect(cache.getSession(created.id)?.metadata).toMatchObject({ name: 'Manual name', translateInput: true })

        // `false` is stored explicitly so carry-forward cannot resurrect `true`.
        await cache.setSessionTranslateInput(created.id, false)
        expect(store.sessions.getSession(created.id)?.metadata).toMatchObject({ translateInput: false })
        expect(events.some((event) => event.type === 'session-updated')).toBe(true)
    })
})
