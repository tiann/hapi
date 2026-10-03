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

describe('schema migration v26 to v27', () => {
    it('adds a language column to users and round-trips it', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v26-'))
        tempDirs.push(dir)
        const dbPath = join(dir, 'hapi.db')

        new Store(dbPath).close()

        const legacy = new Database(dbPath)
        legacy.exec(`
            ALTER TABLE users DROP COLUMN language;
            PRAGMA user_version = 26;
        `)
        legacy.close()

        const migrated = new Store(dbPath)
        const internalDb = (migrated as unknown as { db: Database }).db
        const version = internalDb.prepare('PRAGMA user_version').get() as { user_version: number }
        expect(version.user_version).toBe(29)

        const columns = internalDb.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>
        expect(columns.some((column) => column.name === 'language')).toBe(true)

        migrated.users.addUser('telegram', '42', 'default', 'ru')
        expect(migrated.users.getUser('telegram', '42')?.language).toBe('ru')

        migrated.users.setUserLanguage('telegram', '42', 'en')
        expect(migrated.users.getUser('telegram', '42')?.language).toBe('en')

        migrated.close()
    })

    it('finishes migration when a legacy database has no users table', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v26-legacy-'))
        tempDirs.push(dir)
        const dbPath = join(dir, 'hapi.db')

        new Store(dbPath).close()

        const legacy = new Database(dbPath)
        legacy.exec(`
            PRAGMA foreign_keys = OFF;
            DROP TABLE users;
            PRAGMA user_version = 26;
        `)
        legacy.close()

        const migrated = new Store(dbPath)
        const internalDb = (migrated as unknown as { db: Database }).db
        const version = internalDb.prepare('PRAGMA user_version').get() as { user_version: number }
        expect(version.user_version).toBe(29)

        const usersTable = internalDb
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'")
            .get()
        expect(usersTable).toBeNull()

        migrated.close()
    })
})
