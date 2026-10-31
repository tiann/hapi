import { afterEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from './index'

const tempDirs: string[] = []

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 })
    }
})

describe('schema migration v26 through v30', () => {
    it('preserves the upstream scheduled index and adds task backfill state to a V26 database', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v27-'))
        tempDirs.push(dir)
        const dbPath = join(dir, 'hapi.db')

        new Store(dbPath).close()
        const legacy = new Database(dbPath)
        legacy.exec(`
            DROP TABLE migration_state;
            DROP INDEX idx_messages_future_scheduled_queued;
            PRAGMA user_version = 26;
        `)
        legacy.close()

        const migrated = new Store(dbPath)
        const internalDb = (migrated as unknown as { db: Database }).db
        const tableStatement = internalDb.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migration_state'"
        )
        const table = tableStatement.get() as { name: string } | null
        tableStatement.finalize()
        const versionStatement = internalDb.prepare('PRAGMA user_version')
        const version = versionStatement.get() as { user_version: number }
        versionStatement.finalize()

        expect(table?.name).toBe('migration_state')
        const indexStatement = internalDb.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_messages_future_scheduled_queued'"
        )
        const index = indexStatement.get()
        indexStatement.finalize()
        expect(index).not.toBeNull()
        expect(version.user_version).toBe(30)
        migrated.close()
    })
})
