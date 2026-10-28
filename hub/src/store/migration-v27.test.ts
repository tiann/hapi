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
    it('adds a language column to push_subscriptions and round-trips it', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v27-'))
        tempDirs.push(dir)
        const dbPath = join(dir, 'hapi.db')

        new Store(dbPath).close()

        const legacy = new Database(dbPath)
        legacy.exec(`
            ALTER TABLE push_subscriptions DROP COLUMN language;
            PRAGMA user_version = 27;
        `)
        legacy.close()

        const migrated = new Store(dbPath)
        const internalDb = (migrated as unknown as { db: Database }).db
        const version = internalDb.prepare('PRAGMA user_version').get() as { user_version: number }
        expect(version.user_version).toBe(29)

        migrated.push.addPushSubscription('default', {
            endpoint: 'https://push.example/1',
            p256dh: 'p256dh',
            auth: 'auth',
            language: 'ru'
        })
        const stored = migrated.push.getPushSubscriptionsByNamespace('default')
        expect(stored).toHaveLength(1)
        expect(stored[0]?.language).toBe('ru')

        // Re-subscribing refreshes the stored language.
        migrated.push.addPushSubscription('default', {
            endpoint: 'https://push.example/1',
            p256dh: 'p256dh',
            auth: 'auth',
            language: 'en'
        })
        expect(migrated.push.getPushSubscriptionsByNamespace('default')[0]?.language).toBe('en')

        migrated.close()
    })

    it('finishes migration when a legacy database has no push_subscriptions table', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v27-legacy-'))
        tempDirs.push(dir)
        const dbPath = join(dir, 'hapi.db')

        new Store(dbPath).close()

        const legacy = new Database(dbPath)
        legacy.exec(`
            DROP TABLE push_subscriptions;
            PRAGMA user_version = 27;
        `)
        legacy.close()

        const migrated = new Store(dbPath)
        const internalDb = (migrated as unknown as { db: Database }).db
        const version = internalDb.prepare('PRAGMA user_version').get() as { user_version: number }
        expect(version.user_version).toBe(29)

        const table = internalDb
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'push_subscriptions'")
            .get()
        expect(table).toBeNull()

        migrated.close()
    })
})
