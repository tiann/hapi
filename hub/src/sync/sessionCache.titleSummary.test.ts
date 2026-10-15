import { describe, expect, it } from 'bun:test'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store } from '../store'
import { machineSpawnPreallocTag } from '../store/sessions'
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

describe('human chat titles', () => {
    it('preserves a human rename back to the folder name after an automatic title', async () => {
        const store = new Store(':memory:')
        try {
            const cache = new SessionCache(store, createPublisher([]))
            const session = cache.getOrCreateSession('sports', { path: '/projects/sports', host: 'localhost' }, null, 'default')
            const automatic = store.sessions.updateSessionMetadata(session.id,
                { path: '/projects/sports', host: 'localhost', name: 'Match analysis' }, session.metadataVersion, 'default')
            expect(automatic.result).toBe('success')
            cache.refreshSession(session.id)
            await cache.renameSession(session.id, 'sports')
            const renamed = store.sessions.getSession(session.id)!
            const incoming = store.sessions.updateSessionMetadata(session.id,
                { path: '/projects/sports', host: 'localhost', name: 'Peer message title' }, renamed.metadataVersion, 'default')
            expect(incoming.result).toBe('success')
            cache.refreshSession(session.id)
            expect(cache.getSession(session.id)?.metadata?.name).toBe('sports')
        } finally {
            store.close()
        }
    })
})


describe('human title persistence', () => {
    it('survives summary writes, reload, reopen and sparse or null agent snapshots', async () => {
        const store = new Store(':memory:')
        try {
            let cache = new SessionCache(store, createPublisher([]))
            const session = cache.getOrCreateSession('persistent-title', {
                path: '/projects/sports', host: 'localhost', flavor: 'codex', codexSessionId: 'thread-id'
            }, null, 'default')
            await cache.renameSession(session.id, 'ABC')
            await cache.updateSessionSummary(session.id, 'Generated summary')
            cache = new SessionCache(store, createPublisher([]))
            cache.refreshSession(session.id)
            await cache.clearSessionArchiveMetadata(session.id)
            for (const snapshot of [
                { name: 'New automatic title', userChosenName: 'Forged choice' },
                { name: null, userChosenName: null },
                null,
                { lifecycleState: 'running' }
            ]) {
                const stored = store.sessions.getSession(session.id)!
                const result = store.sessions.updateSessionMetadata(session.id, snapshot, stored.metadataVersion, 'default')
                expect(result.result).toBe('success')
                cache.refreshSession(session.id)
                expect(cache.getSession(session.id)?.metadata?.name).toBe('ABC')
            }
            await cache.renameSession(session.id, 'Second choice')
            await cache.updateSessionSummary(session.id, 'Another summary')
            expect(cache.getSession(session.id)?.metadata?.name).toBe('Second choice')
        } finally {
            store.close()
        }
    })

    it('retries a human rename after concurrent metadata changes without losing those changes', async () => {
        const store = new Store(':memory:')
        try {
            const cache = new SessionCache(store, createPublisher([]))
            const session = cache.getOrCreateSession('contended-title', { path: '/sports', host: 'localhost' }, null, 'default')
            await cache.renameSession(session.id, 'ABC')
            const previous = store.sessions.getSession(session.id)!
            store.sessions.updateSessionMetadata(session.id, {
                path: '/sports', host: 'localhost', name: 'Automatic', summary: { text: 'Concurrent summary', updatedAt: 10 }
            }, previous.metadataVersion, 'default')
            await cache.renameSession(session.id, 'sports')
            const stale = store.sessions.updateSessionMetadata(session.id,
                { name: 'Stale automatic title' }, previous.metadataVersion, 'default')
            expect(stale.result).toBe('version-mismatch')
            expect(cache.getSession(session.id)?.metadata).toMatchObject({
                name: 'sports', summary: { text: 'Concurrent summary' }
            })
        } finally {
            store.close()
        }
    })

    it('allows repeated automatic naming and rejects forged human ownership at bootstrap', () => {
        const store = new Store(':memory:')
        try {
            const cache = new SessionCache(store, createPublisher([]))
            const session = cache.getOrCreateSession('automatic-title', {
                path: '/sports', host: 'localhost', name: 'First title', userChosenName: 'Forged choice'
            }, null, 'default')
            for (const name of ['Second title', 'Third title']) {
                const stored = store.sessions.getSession(session.id)!
                const result = store.sessions.updateSessionMetadata(session.id,
                    { path: '/sports', host: 'localhost', name, userChosenName: 'Forged choice' }, stored.metadataVersion, 'default')
                expect(result.result).toBe('success')
                cache.refreshSession(session.id)
                expect(cache.getSession(session.id)?.metadata?.name).toBe(name)
            }
        } finally {
            store.close()
        }
    })
})

it('preserves a user-chosen title when resume replaces the session row', async () => {
    const store = new Store(':memory:')
    try {
        const cache = new SessionCache(store, createPublisher([]))
        const old = cache.getOrCreateSession('before-resume', { path: '/sports', host: 'localhost' }, null, 'default')
        await cache.renameSession(old.id, 'sports')
        const next = cache.getOrCreateSession('after-resume', { path: '/sports', host: 'localhost', name: 'Bootstrap title' }, null, 'default')
        await cache.mergeSessions(old.id, next.id, 'default')
        const stored = store.sessions.getSession(next.id)!
        const result = store.sessions.updateSessionMetadata(next.id,
            { path: '/sports', host: 'localhost', name: 'Automatic after resume' }, stored.metadataVersion, 'default')
        expect(result.result).toBe('success')
        cache.refreshSession(next.id)
        expect(cache.getSession(next.id)?.metadata?.name).toBe('sports')
    } finally {
        store.close()
    }
})

it('keeps the destination user title when merging two explicitly renamed sessions', async () => {
    const store = new Store(':memory:')
    try {
        const cache = new SessionCache(store, createPublisher([]))
        const source = cache.getOrCreateSession('source-title', { path: '/sports', host: 'localhost' }, null, 'default')
        const destination = cache.getOrCreateSession('destination-title', { path: '/sports', host: 'localhost' }, null, 'default')
        await cache.renameSession(source.id, 'Source choice')
        await cache.renameSession(destination.id, 'Destination choice')
        await cache.mergeSessions(source.id, destination.id, 'default')
        await cache.updateSessionSummary(destination.id, 'Generated summary')
        expect(cache.getSession(destination.id)?.metadata?.name).toBe('Destination choice')
    } finally {
        store.close()
    }
})


it('rejects forged human ownership when a CLI adopts a preallocated session', () => {
    const store = new Store(':memory:')
    try {
        const session = store.sessions.getOrCreateSession(machineSpawnPreallocTag('preallocated-title'), {
            path: '/sports', host: 'localhost'
        }, null, 'default', undefined, undefined, undefined, 'preallocated-title')
        const adopted = store.sessions.adoptPreallocatedSession(session.id, 'cli-bootstrap', {
            path: '/sports', host: 'localhost', name: 'Bootstrap title', userChosenName: 'Forged choice'
        }, null, 'default')
        const result = store.sessions.updateSessionMetadata(session.id,
            { path: '/sports', host: 'localhost', name: 'Automatic title' }, adopted.metadataVersion, 'default')
        expect(result.result).toBe('success')
        const cache = new SessionCache(store, createPublisher([]))
        cache.refreshSession(session.id)
        expect(cache.getSession(session.id)?.metadata?.name).toBe('Automatic title')
    } finally {
        store.close()
    }
})

it('keeps the source session if its chosen title cannot be transferred', async () => {
    const store = new Store(':memory:')
    try {
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))
        const source = cache.getOrCreateSession('failed-source-title', { path: '/sports', host: 'localhost' }, null, 'default')
        const destination = cache.getOrCreateSession('failed-destination-title', { path: '/sports', host: 'localhost' }, null, 'default')
        await cache.renameSession(source.id, 'Chosen title')
        store.messages.addMessage(source.id, { role: 'user', content: { type: 'text', text: 'Original message' } })
        store.scratchlist.create(source.id, 'Original note')
        events.length = 0
        const update = store.sessions.updateSessionMetadata.bind(store.sessions)
        store.sessions.updateSessionMetadata = (...args) => args[4]?.inheritUserChosenNameFrom
            ? { result: 'error' }
            : update(...args)
        await expect(cache.mergeSessions(source.id, destination.id, 'default')).rejects.toThrow('Failed to preserve user-chosen title')
        expect(cache.getSession(source.id)?.metadata?.name).toBe('Chosen title')
        expect(store.messages.getMessages(source.id)).toHaveLength(1)
        expect(store.messages.getMessages(destination.id)).toHaveLength(0)
        expect(store.scratchlist.list(source.id)).toHaveLength(1)
        expect(store.scratchlist.list(destination.id)).toHaveLength(0)
        expect(events).toHaveLength(0)
    } finally {
        store.close()
    }
})

it('drops unrelated metadata on a null snapshot while retaining a valid chosen title', async () => {
    const store = new Store(':memory:')
    try {
        const cache = new SessionCache(store, createPublisher([]))
        const session = cache.getOrCreateSession('null-title', {
            path: '/sports', host: 'localhost', flavor: 'codex', machineId: 'machine', codexSessionId: 'thread',
            summary: { text: 'Old summary', updatedAt: 1 }, thinking: true
        }, null, 'default')
        await cache.renameSession(session.id, 'ABC')
        const stored = store.sessions.getSession(session.id)!
        const result = store.sessions.updateSessionMetadata(session.id, null, stored.metadataVersion, 'default')
        expect(result.result).toBe('success')
        cache.refreshSession(session.id)
        expect(cache.getSession(session.id)?.metadata).toMatchObject({
            name: 'ABC', path: '/sports', host: 'localhost', flavor: 'codex', machineId: 'machine', codexSessionId: 'thread'
        })
        expect(cache.getSession(session.id)?.metadata?.summary).toBeUndefined()
        expect(store.sessions.getSession(session.id)?.metadata).not.toHaveProperty('thinking')
        const unlocked = cache.getOrCreateSession('null-unlocked', { path: '/sports', host: 'localhost', name: 'Generated' }, null, 'default')
        expect(store.sessions.updateSessionMetadata(unlocked.id, null, unlocked.metadataVersion, 'default').result).toBe('success')
        cache.refreshSession(unlocked.id)
        expect(cache.getSession(unlocked.id)?.metadata).toBeNull()
    } finally {
        store.close()
    }
})

it('preserves concurrent destination metadata when title inheritance retries', async () => {
    const store = new Store(':memory:')
    try {
        const cache = new SessionCache(store, createPublisher([]))
        const source = cache.getOrCreateSession('contended-source', { path: '/sports', host: 'localhost' }, null, 'default')
        const destination = cache.getOrCreateSession('contended-destination', { path: '/sports', host: 'localhost', name: 'Bootstrap' }, null, 'default')
        await cache.renameSession(source.id, 'Chosen title')
        const update = store.sessions.updateSessionMetadata.bind(store.sessions)
        let contend = true
        store.sessions.updateSessionMetadata = (...args) => {
            if (contend && args[4]?.inheritUserChosenNameFrom) {
                contend = false
                const current = store.sessions.getSession(destination.id)!
                update(destination.id, {
                    ...current.metadata as Record<string, unknown>, summary: { text: 'Concurrent summary', updatedAt: 100 }
                }, current.metadataVersion, 'default')
            }
            return update(...args)
        }
        await cache.mergeSessions(source.id, destination.id, 'default')
        expect(cache.getSession(destination.id)?.metadata).toMatchObject({
            name: 'Chosen title', summary: { text: 'Concurrent summary', updatedAt: 100 }
        })
    } finally {
        store.close()
    }
})
