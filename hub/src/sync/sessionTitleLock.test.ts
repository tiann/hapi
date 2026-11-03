import { describe, expect, it } from 'bun:test'
import { Store } from '../store'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { machineSpawnPreallocTag } from '../store/sessions'
import { SessionCache } from './sessionCache'
import type { EventPublisher } from './eventPublisher'

function setup() {
    const store = new Store(':memory:')
    const cache = new SessionCache(store, { emit() {} } as unknown as EventPublisher)
    const create = (tag: string) => cache.getOrCreateSession(tag, {
        path: '/project', host: 'localhost', name: 'Original',
        summary: { text: 'Original summary', updatedAt: 1 }
    }, null, 'default')
    const write = (id: string, metadata: unknown) => {
        const current = store.sessions.getSession(id)!
        return store.sessions.updateSessionMetadata(id, metadata, current.metadataVersion, 'default')
    }
    return { store, cache, create, write }
}

describe('explicit per-session title lock', () => {
    it('preserves summary-only titles through lock-only saves and native updates after unlock', async () => {
        const { store, cache, write } = setup()
        try {
            const session = cache.getOrCreateSession('summary-only', {
                path: '/project', host: 'localhost', summary: { text: 'Native title', updatedAt: 1 }
            }, null, 'default')
            await cache.renameSession(session.id, undefined, true)
            write(session.id, { summary: { text: 'Blocked native title', updatedAt: 2 } })
            expect(store.sessions.getSession(session.id)?.metadata).toMatchObject({ titleLocked: true, summary: { text: 'Native title' } })
            cache.refreshSession(session.id)
            await cache.renameSession(session.id, undefined, false)
            write(session.id, { summary: { text: 'New native title', updatedAt: 3 } })
            expect(store.sessions.getSession(session.id)?.metadata).toMatchObject({ summary: { text: 'New native title' } })
            expect(store.sessions.getSession(session.id)?.metadata).not.toHaveProperty('name')
        } finally { store.close() }
    })

    it('allows agent renames after a manual rename unless explicitly locked', async () => {
        const { store, cache, create, write } = setup()
        try {
            const session = create('unlocked')
            await cache.renameSession(session.id, 'User title')
            write(session.id, { name: 'Agent title' })
            expect(store.sessions.getSession(session.id)?.metadata).toMatchObject({ name: 'Agent title' })
        } finally { store.close() }
    })

    it('protects both title fields against sparse, null, forged, and stale agent snapshots', async () => {
        const { store, cache, create, write } = setup()
        try {
            const session = create('locked')
            await cache.renameSession(session.id, 'User title', true)
            for (const metadata of [
                { name: 'Agent', titleLocked: false, summary: { text: 'New', updatedAt: 2 } },
                { titleLocked: null }, null, { lifecycleState: 'running' }
            ]) {
                expect(write(session.id, metadata).result).toBe('success')
                expect(store.sessions.getSession(session.id)?.metadata).toMatchObject({
                    name: 'User title', titleLocked: true, summary: { text: 'Original summary' }
                })
            }
            cache.refreshSession(session.id)
            await cache.clearSessionArchiveMetadata(session.id)
            expect(store.sessions.getSession(session.id)?.metadata).toMatchObject({ titleLocked: true, name: 'User title' })
        } finally { store.close() }
    })

    it('keeps sessions independent, permits user edits, and unlocks only on explicit user save', async () => {
        const { store, cache, create, write } = setup()
        try {
            const first = create('first'), second = create('second')
            await cache.renameSession(first.id, 'Pinned', true)
            write(second.id, { name: 'Other agent title', titleLocked: true })
            expect(store.sessions.getSession(second.id)?.metadata).not.toHaveProperty('titleLocked', true)
            cache.refreshSession(first.id)
            await cache.renameSession(first.id, 'User edit')
            write(first.id, { name: 'Blocked' })
            expect(store.sessions.getSession(first.id)?.metadata).toMatchObject({ name: 'User edit', titleLocked: true })
            cache.refreshSession(first.id)
            await cache.renameSession(first.id, 'User edit', false)
            write(first.id, { name: 'Agent after unlock' })
            expect(store.sessions.getSession(first.id)?.metadata).toMatchObject({ name: 'Agent after unlock' })
        } finally { store.close() }
    })

    it('lets a user save a generated title and lock atomically', async () => {
        const { store, cache, create, write } = setup()
        try {
            const session = create('generated')
            await cache.updateSessionSummary(session.id, 'User generated', true)
            write(session.id, { name: 'Agent', summary: { text: 'Agent summary' } })
            expect(store.sessions.getSession(session.id)?.metadata).toMatchObject({
                titleLocked: true, name: 'Original', summary: { text: 'User generated' }
            })
        } finally { store.close() }
    })
})

it('persists a lock through a real database close and reopen', () => {
    const directory = mkdtempSync(join(tmpdir(), 'hapi-title-lock-'))
    try {
        // Separate processes guarantee an actual restart and release SQLite
        // prepared-statement handles before cleanup on Windows.
        const dbPath = join(directory, 'hapi.db')
        const imports = `import { Store } from './hub/src/store'; import { SessionCache } from './hub/src/sync/sessionCache';`
        const create = Bun.spawnSync([process.execPath, '-e', imports + `
            const store = new Store(process.argv[1]);
            const cache = new SessionCache(store, { emit() {} });
            const session = cache.getOrCreateSession('persist', { path: '/project', host: 'localhost' }, null, 'default');
            await cache.renameSession(session.id, 'Pinned', true); store.close();
        `, dbPath], { cwd: join(import.meta.dir, '../../..') })
        expect(create.exitCode).toBe(0)
        const reopen = Bun.spawnSync([process.execPath, '-e', imports + `
            const store = new Store(process.argv[1]); const current = store.sessions.getSessions()[0];
            store.sessions.updateSessionMetadata(current.id, { name: 'After restart' }, current.metadataVersion, 'default');
            console.log(JSON.stringify(store.sessions.getSession(current.id).metadata)); store.close();
        `, dbPath], { cwd: join(import.meta.dir, '../../..') })
        expect(reopen.exitCode).toBe(0)
        expect(JSON.parse(reopen.stdout.toString())).toMatchObject({ titleLocked: true, name: 'Pinned' })
    } finally { rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) }
})

it('preserves a preallocated lock at adoption and rejects forged bootstrap locks', async () => {
    const { store, cache } = setup()
    try {
        const stub = store.sessions.getOrCreateSession(machineSpawnPreallocTag('stub-lock'), {
            path: '/project', host: 'localhost', titleLocked: true
        }, null, 'default', undefined, undefined, undefined, 'stub-lock')
        expect(stub.metadata).not.toHaveProperty('titleLocked', true)
        await cache.renameSession(stub.id, 'Pinned before bootstrap', true)
        const adopted = store.sessions.adoptPreallocatedSession(stub.id, 'real-agent', {
            path: '/new', host: 'localhost', name: 'Agent', titleLocked: false
        }, null, 'default')
        expect(adopted.metadata).toMatchObject({ titleLocked: true, name: 'Pinned before bootstrap' })
    } finally { store.close() }
})

it('retains the destination lock, transfers a resumed lock, and keeps history imports independent', async () => {
    const { store, cache, create, write } = setup()
    try {
        const source = create('source'), destination = create('destination')
        await cache.renameSession(source.id, 'Source pinned', true)
        await cache.mergeSessions(source.id, destination.id, 'default')
        write(destination.id, { name: 'After resume' })
        expect(store.sessions.getSession(destination.id)?.metadata).toMatchObject({ titleLocked: true, name: 'Source pinned' })
        const other = create('other')
        await cache.renameSession(other.id, 'Destination pinned', true)
        await cache.mergeSessions(destination.id, other.id, 'default')
        expect(store.sessions.getSession(other.id)?.metadata).toMatchObject({ titleLocked: true, name: 'Destination pinned' })
        const independent = create('independent')
        await cache.mergeSessionHistory(other.id, independent.id, 'default')
        expect(store.sessions.getSession(independent.id)?.metadata).not.toHaveProperty('titleLocked', true)
    } finally { store.close() }
})

it('does not move history when title transfer fails', async () => {
    const { store, cache, create } = setup()
    try {
        const source = create('failed-source'), destination = create('failed-destination')
        await cache.renameSession(source.id, 'Pinned', true)
        store.messages.addMessage(source.id, { text: 'Keep history' })
        const update = store.sessions.updateSessionMetadata.bind(store.sessions)
        store.sessions.updateSessionMetadata = (...args) => args[4]?.inheritTitleLockFrom ? { result: 'error' } : update(...args)
        await expect(cache.mergeSessions(source.id, destination.id, 'default')).rejects.toThrow('preserve session metadata')
        expect(store.messages.getAllMessages(source.id)).toHaveLength(1)
        expect(store.messages.getAllMessages(destination.id)).toHaveLength(0)
        expect(store.sessions.getSession(source.id)?.metadata).toMatchObject({ titleLocked: true })
    } finally { store.close() }
})
