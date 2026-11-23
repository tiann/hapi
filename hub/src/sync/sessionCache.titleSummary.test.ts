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

    it.each([null, 'Previous name'])('rejects replacement if the current manual name differs from %s', async (expectedName) => {
        const store = new Store(':memory:')
        const cache = new SessionCache(store, createPublisher([]))
        const created = cache.getOrCreateSession(
            'summary-concurrent-rename',
            { path: '/tmp', host: 'localhost', name: 'Newer manual name', summary: { text: 'Old summary', updatedAt: 1 } },
            null,
            'default'
        )

        await expect(cache.updateSessionSummary(created.id, 'Generated title', {
            clearName: true, expectedName, titleLocked: true
        })).rejects.toThrow('concurrently')
        expect(store.sessions.getSession(created.id)?.metadata).toMatchObject({
            name: 'Newer manual name', summary: { text: 'Old summary' }
        })
        expect(cache.getSession(created.id)?.metadata?.titleLocked).not.toBe(true)
    })

    it('rechecks the expected name after retrying a stale cached version', async () => {
        const store = new Store(':memory:')
        const cache = new SessionCache(store, createPublisher([]))
        const created = cache.getOrCreateSession('summary-stale-cache', { path: '/tmp', host: 'localhost' }, null, 'default')
        const metadata = { path: '/tmp', host: 'localhost', name: 'Newer manual name' }
        const result = store.sessions.updateSessionMetadata(created.id, metadata, created.metadataVersion, 'default')
        expect(result.result).toBe('success')
        expect(cache.getSession(created.id)?.metadata?.name).toBeUndefined()

        await expect(cache.updateSessionSummary(created.id, 'Generated title', {
            clearName: true, expectedName: null
        })).rejects.toThrow('concurrently')
        expect(store.sessions.getSession(created.id)?.metadata).toHaveProperty('name', 'Newer manual name')
        expect(store.sessions.getSession(created.id)?.metadata).not.toHaveProperty('summary')
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
