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

describe('schema migration v22 to v25', () => {
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
        expect(version.user_version).toBe(25)
        migrated.close()
    })
})
