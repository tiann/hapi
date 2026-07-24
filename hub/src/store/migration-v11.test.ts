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

describe('schema migration v10 to v11', () => {
    it('adds the pinned column with an unpinned default', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v11-'))
        tempDirs.push(dir)
        const dbPath = join(dir, 'hapi.db')

        new Store(dbPath).close()
        const legacy = new Database(dbPath)
        legacy.exec('ALTER TABLE sessions DROP COLUMN pinned')
        legacy.exec('PRAGMA user_version = 10')
        legacy.close()

        const migrated = new Store(dbPath)
        const session = migrated.sessions.getOrCreateSession('migration-pin', {}, null, 'default')
        expect(session.pinned).toBe(false)
        migrated.close()
    })
})
