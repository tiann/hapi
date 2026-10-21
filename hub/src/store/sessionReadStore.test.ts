import { afterEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { Store } from './index'

const stores: Store[] = []
const dirs: string[] = []
afterEach(() => {
    for (const store of stores.splice(0)) store.close()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})
function setup(path = ':memory:') {
    const store = new Store(path)
    stores.push(store)
    const session = store.sessions.getOrCreateSession('read-test', { path: '/test', host: 'test' }, null, 'default')
    store.sessions.touchSessionUpdatedAt(session.id, 10000, 'default')
    return { store, id: session.id }
}

describe('shared session read state', () => {
    it('persists read positions without touching session activity, then cascades deletion', () => {
        const { store, id } = setup()
        const before = store.sessions.getSession(id)!.updatedAt
        expect(store.sessionReads.update('default', [{ mutationId: 'seen-100', sessionId: id, kind: 'seen', activityAt: 100, expectedVersion: 0 }]).states)
            .toEqual([{ sessionId: id, lastSeenAt: 100, manualUnreadAt: null, version: 1 }])
        expect(store.sessions.getSession(id)!.updatedAt).toBe(before)
        expect(store.sessionReads.update('default', [{ mutationId: 'seen-50', sessionId: id, kind: 'seen', activityAt: 50, expectedVersion: 1 }]).states[0]!.lastSeenAt).toBe(100)
        store.sessions.deleteSession(id, 'default')
        expect(store.sessionReads.list('default')).toEqual([])
    })

    it('rejects stale and duplicate requests without erasing manual unread state', () => {
        const { store, id } = setup()
        const seen = { mutationId: 'seen-original', sessionId: id, kind: 'seen' as const, activityAt: 100, expectedVersion: 0 }
        store.sessionReads.update('default', [seen])
        store.sessionReads.update('default', [{ mutationId: 'unread-100', sessionId: id, kind: 'unread', activityAt: 100, expectedVersion: 1 }])
        const unread = store.sessionReads.list('default')
        expect(unread[0]).toMatchObject({ lastSeenAt: 99, manualUnreadAt: 100, version: 2 })
        expect(store.sessionReads.update('default', [seen]).states).toEqual(unread)
        expect(store.sessionReads.update('default', [{ ...seen, expectedVersion: 1 }]).states).toEqual(unread)
        expect(store.sessionReads.update('default', [{ ...seen, mutationId: 'new-seen', expectedVersion: 2 }]).states[0])
            .toMatchObject({ lastSeenAt: 100, manualUnreadAt: null, version: 3 })
    })

    it('keeps newer activity unread when an observed older position is acknowledged', () => {
        const { store, id } = setup()
        store.sessionReads.update('default', [{ mutationId: 'unread-100', sessionId: id, kind: 'unread', activityAt: 200, expectedVersion: 0 }])
        expect(store.sessionReads.update('default', [{ mutationId: 'seen-100-later', sessionId: id, kind: 'seen', activityAt: 100, expectedVersion: 1 }]).states[0])
            .toMatchObject({ lastSeenAt: 100, manualUnreadAt: 200 })
    })

    it('rolls back mixed namespace batches and does not expose foreign read state', () => {
        const { store, id } = setup()
        const foreign = store.sessions.getOrCreateSession('foreign', {}, null, 'other')
        expect(() => store.sessionReads.update('default', [
            { mutationId: 'seen-100', sessionId: id, kind: 'seen', activityAt: 100, expectedVersion: 0 },
            { mutationId: 'foreign', sessionId: foreign.id, kind: 'seen', activityAt: 100, expectedVersion: 0 }
        ])).toThrow('session-not-found')
        expect(store.sessionReads.list('default')).toEqual([])
        store.sessionReads.update('other', [{ mutationId: 'foreign', sessionId: foreign.id, kind: 'seen', activityAt: 100, expectedVersion: 0 }])
        expect(store.sessionReads.list('default')).toEqual([])
    })

    it('imports manual unread only once and rejects positions beyond observed activity', () => {
        const { store, id } = setup()
        const mutation = { mutationId: 'import-original', sessionId: id, kind: 'import-unread' as const, activityAt: 100, expectedVersion: 0 }
        store.sessionReads.update('default', [mutation])
        store.sessionReads.update('default', [{ ...mutation, mutationId: 'new-seen', kind: 'seen', expectedVersion: 1 }])
        store.sessionReads.update('default', [mutation])
        expect(store.sessionReads.list('default')[0]).toMatchObject({ lastSeenAt: 100, manualUnreadAt: null, version: 2 })
        expect(() => store.sessionReads.update('default', [{ ...mutation, activityAt: Number.MAX_SAFE_INTEGER }])).toThrow('future-activity')
    })

    it('migrates v26 without changing session rows and survives a store restart', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-read-sync-'))
        dirs.push(dir)
        const path = join(dir, 'test.db')
        const run = (source: string) => {
            const result = spawnSync(process.execPath, ['-e', `
                import { Store } from ${JSON.stringify(pathToFileURL(join(import.meta.dir, 'index.ts')).href)};
                const path = process.argv[1];
                ${source}
            `, path], { encoding: 'utf8' })
            expect(result.stderr).toBe('')
            expect(result.status).toBe(0)
            return JSON.parse(result.stdout.trim())
        }
        const original = run(`
            const store = new Store(path);
            const session = store.sessions.getOrCreateSession('test', {}, null, 'default');
            console.log(JSON.stringify(session)); store.close();
        `)
        const legacy = new Database(path)
        legacy.exec('DROP TABLE session_read_states; PRAGMA user_version = 26')
        legacy.close()
        const migrated = run(`
            const store = new Store(path);
            const session = store.sessions.getSessionsByNamespace('default')[0];
            const before = store.sessionReads.list('default');
            store.sessionReads.update('default', [{ mutationId: 'persisted', sessionId: session.id, kind: 'unread', activityAt: 100, expectedVersion: 0 }]);
            console.log(JSON.stringify({ session, before })); store.close();
        `)
        expect(migrated.session).toEqual(original)
        expect(migrated.before).toEqual([])
        const reopened = run(`const store = new Store(path); console.log(JSON.stringify(store.sessionReads.list('default'))); store.close();`)
        expect(reopened[0]).toMatchObject({ manualUnreadAt: 100, version: 1 })
    }, 30000)
})
