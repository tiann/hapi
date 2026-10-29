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

describe('schema migration v27 to v28', () => {
    it('adds session_turns, allowing one open turn per session', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v27-'))
        tempDirs.push(dir)
        const dbPath = join(dir, 'hapi.db')

        const original = new Store(dbPath)
        const session = original.sessions.getOrCreateSession('tag', { path: '/tmp', host: 'mac' }, null, 'default')
        original.close()
        const legacy = new Database(dbPath)
        legacy.exec(`
            DROP TABLE session_turns;
            PRAGMA user_version = 27;
        `)
        legacy.close()

        const migrated = new Store(dbPath)
        const internalDb = (migrated as unknown as { db: Database }).db
        const version = internalDb.prepare('PRAGMA user_version').get() as { user_version: number }
        expect(version.user_version).toBe(28)

        expect(migrated.turns.open(session.id, 'default', 1_000, 'agent')).toBe(true)
        expect(migrated.turns.open(session.id, 'default', 2_000, 'agent')).toBe(false)
        expect(migrated.turns.list('default', 0, 10_000)).toHaveLength(1)
        migrated.close()
    })
})
