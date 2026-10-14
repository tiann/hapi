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

describe('schema migration v28 to v29', () => {
    it('adds a language column to fcm_devices and round-trips it', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v28-'))
        tempDirs.push(dir)
        const dbPath = join(dir, 'hapi.db')

        new Store(dbPath).close()

        const legacy = new Database(dbPath)
        legacy.exec(`
            ALTER TABLE fcm_devices DROP COLUMN language;
            PRAGMA user_version = 28;
        `)
        legacy.close()

        const migrated = new Store(dbPath)
        const internalDb = (migrated as unknown as { db: Database }).db
        const version = internalDb.prepare('PRAGMA user_version').get() as { user_version: number }
        expect(version.user_version).toBe(29)

        migrated.fcm.upsertDevice('default', {
            token: 'fcm-token',
            platform: 'phone',
            deviceId: 'device-1',
            language: 'ru'
        })
        const stored = migrated.fcm.getDevicesByNamespace('default', ['phone'])
        expect(stored).toHaveLength(1)
        expect(stored[0]?.language).toBe('ru')

        // Re-registering the same install refreshes the language.
        migrated.fcm.upsertDevice('default', {
            token: 'fcm-token',
            platform: 'phone',
            deviceId: 'device-1',
            language: 'en'
        })
        expect(migrated.fcm.getDevicesByNamespace('default', ['phone'])[0]?.language).toBe('en')

        migrated.close()
    })

    it('finishes migration when a legacy database has no fcm_devices table', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v28-legacy-'))
        tempDirs.push(dir)
        const dbPath = join(dir, 'hapi.db')

        new Store(dbPath).close()

        const legacy = new Database(dbPath)
        legacy.exec(`
            DROP TABLE fcm_devices;
            PRAGMA user_version = 28;
        `)
        legacy.close()

        const migrated = new Store(dbPath)
        const internalDb = (migrated as unknown as { db: Database }).db
        const version = internalDb.prepare('PRAGMA user_version').get() as { user_version: number }
        expect(version.user_version).toBe(29)

        const table = internalDb
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'fcm_devices'")
            .get()
        expect(table).toBeNull()

        migrated.close()
    })
})
