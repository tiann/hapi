import { afterEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from './index'

const tempDirs: string[] = []

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true })
    }
})

describe('schema migration v22 to v26', () => {
    it('adds events and event_links tables to a V22 database', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v23-'))
        tempDirs.push(dir)
        const dbPath = join(dir, 'hapi.db')

        new Store(dbPath).close()
        const legacy = new Database(dbPath)
        legacy.exec(`
            DROP TABLE IF EXISTS event_links;
            DROP TABLE IF EXISTS events;
            PRAGMA user_version = 22;
        `)
        legacy.close()

        const migrated = new Store(dbPath)
        const internalDb = (migrated as unknown as { db: Database }).db
        const events = internalDb.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events'"
        ).get() as { name: string } | null
        const links = internalDb.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'event_links'"
        ).get() as { name: string } | null
        const version = internalDb.prepare('PRAGMA user_version').get() as { user_version: number }

        expect(events?.name).toBe('events')
        expect(links?.name).toBe('event_links')
        const columns = internalDb.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>
        expect(columns.map((column) => column.name)).toContain('delivery_state')
        // Tip after #1404: V23 A2A + V24 push_key + V25 delivery_state + V26 session_jobs.
        expect(version.user_version).toBe(26)
        migrated.close()
    })

    it('on key collision keeps a running source over a terminal target', () => {
        const store = new Store(':memory:')
        const from = store.sessions.getOrCreateSession('from', { path: '/a' }, null, 'default')
        const to = store.sessions.getOrCreateSession('to', { path: '/b' }, null, 'default')
        store.sessionJobs.upsert(to.id, 'beets', {
            label: 'stale',
            status: 'completed',
            remaining: 0
        }, 1_000)
        store.sessionJobs.upsert(from.id, 'beets', {
            label: 'live',
            status: 'running',
            remaining: 3
        }, 2_000)
        const result = store.sessionJobs.transfer(from.id, to.id)
        expect(result.collided).toBe(1)
        expect(result.moved).toBe(1)
        const primary = store.sessionJobs.getPrimaryRunning(to.id)
        expect(primary?.label).toBe('live')
        expect(primary?.status).toBe('running')
        expect(store.sessionJobs.list(from.id)).toHaveLength(0)
        store.close()
    })

    it('on key collision prefers a newer terminal source over an older terminal target', () => {
        const store = new Store(':memory:')
        const from = store.sessions.getOrCreateSession('from-term', { path: '/a' }, null, 'default')
        const to = store.sessions.getOrCreateSession('to-term', { path: '/b' }, null, 'default')
        store.sessionJobs.upsert(to.id, 'beets', {
            label: 'old-complete',
            status: 'completed',
            remaining: 0
        }, 1_000)
        store.sessionJobs.upsert(from.id, 'beets', {
            label: 'new-fail',
            status: 'failed',
            remaining: 0
        }, 2_000)
        const result = store.sessionJobs.transfer(from.id, to.id)
        expect(result.collided).toBe(1)
        expect(result.moved).toBe(1)
        const kept = store.sessionJobs.list(to.id)
        expect(kept).toHaveLength(1)
        expect(kept[0]?.label).toBe('new-fail')
        expect(kept[0]?.status).toBe('failed')
        expect(store.sessionJobs.list(from.id)).toHaveLength(0)
        store.close()
    })

    it('on dual-running same-key collision keeps both under remapped source key', () => {
        const store = new Store(':memory:')
        const fromId = 'aaaaaaaa-1111-1111-1111-111111111111'
        const toId = 'bbbbbbbb-2222-2222-2222-222222222222'
        const from = store.sessions.getOrCreateSession(
            'tag-from-dual',
            { path: '/a' },
            null,
            'default',
            undefined,
            undefined,
            undefined,
            fromId
        )
        const to = store.sessions.getOrCreateSession(
            'tag-to-dual',
            { path: '/b' },
            null,
            'default',
            undefined,
            undefined,
            undefined,
            toId
        )
        expect(from.id).toBe(fromId)
        expect(to.id).toBe(toId)
        store.sessionJobs.upsert(to.id, 'beets', {
            label: 'target-live',
            status: 'running',
            remaining: 9
        }, 1_000)
        store.sessionJobs.upsert(from.id, 'beets', {
            label: 'source-live',
            status: 'running',
            remaining: 3
        }, 2_000)
        const result = store.sessionJobs.transfer(from.id, to.id)
        expect(result.collided).toBe(1)
        expect(result.moved).toBe(1)
        expect(result.keyRedirects).toEqual([
            { fromKey: 'beets', toKey: 'beets.aaaaaaaa' }
        ])
        const onTarget = store.sessionJobs.list(to.id)
        expect(onTarget).toHaveLength(2)
        expect(onTarget.map((j) => j.key).sort()).toEqual(['beets', 'beets.aaaaaaaa'])
        expect(store.sessionJobs.get(to.id, 'beets')?.label).toBe('target-live')
        expect(store.sessionJobs.get(to.id, 'beets.aaaaaaaa')?.label).toBe('source-live')
        expect(store.sessionJobs.list(from.id)).toHaveLength(0)
        store.close()
    })
})
