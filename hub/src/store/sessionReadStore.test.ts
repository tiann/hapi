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

    for (const previousVersion of [26, 27, 28, 29]) it(`migrates v${previousVersion} without changing session rows or losing upstream schema`, () => {
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
        legacy.exec(`DROP TABLE session_read_states; PRAGMA user_version = ${previousVersion}`)
        if (previousVersion === 26) legacy.exec('DROP INDEX idx_messages_future_scheduled_queued')
        if (previousVersion < 28) legacy.exec('DROP TABLE session_turns')
        else legacy.query(`INSERT INTO session_turns(session_id, namespace, started_at, ended_at, started_by)
            VALUES (?, 'default', 10, 20, 'test')`).run(original.id)
        if (previousVersion < 29) legacy.exec('ALTER TABLE sessions DROP COLUMN last_user_message_at')
        legacy.close()
        const migrated = run(`
            const store = new Store(path);
            const session = store.sessions.getSessionsByNamespace('default')[0];
            const before = store.sessionReads.list('default');
            store.sessionReads.update('default', [{ mutationId: 'persisted', sessionId: session.id, kind: 'unread', activityAt: 100, expectedVersion: 0 }]);
            const db = store['db'];
            const version = db.query('PRAGMA user_version').get().user_version;
            const index = db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_messages_future_scheduled_queued'").get();
            const turns = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_turns'").get();
            const turnCount = db.query('SELECT COUNT(*) AS count FROM session_turns').get().count;
            const sessionColumns = db.query('PRAGMA table_info(sessions)').all().map(column => column.name);
            console.log(JSON.stringify({ session, before, version, index, turns, turnCount, sessionColumns })); store.close();
        `)
        expect(migrated.session).toEqual(original)
        expect(migrated.before).toEqual([])
        expect(migrated.version).toBe(30)
        expect(migrated.index?.name).toBe('idx_messages_future_scheduled_queued')
        expect(migrated.turns?.name).toBe('session_turns')
        if (previousVersion >= 28) expect(migrated.turnCount).toBe(1)
        expect(migrated.sessionColumns).toContain('last_user_message_at')
        const reopened = run(`const store = new Store(path); console.log(JSON.stringify(store.sessionReads.list('default'))); store.close();`)
        expect(reopened[0]).toMatchObject({ manualUnreadAt: 100, version: 1 })
    }, 60000)
})
