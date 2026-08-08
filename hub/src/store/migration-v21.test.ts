import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from './index'

describe('Store V21->V22 migration: notification preferences', () => {
    it('creates notification preferences for an existing V21 database', () => {
        const directory = mkdtempSync(join(tmpdir(), 'hapi-migration-v21-to-v22-'))
        const dbPath = join(directory, 'test.db')
        let store: Store | undefined
        try {
            store = new Store(dbPath)
            store.close()
            store = undefined

            const db = new Database(dbPath, { create: true, readwrite: true, strict: true })
            db.exec(`
                DROP TABLE notification_preferences;
                PRAGMA user_version = 21;
            `)
            db.close()

            store = new Store(dbPath)
            const internalDb = (store as unknown as { db: Database }).db
            const table = internalDb.prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notification_preferences'"
            ).get() as { name: string } | null
            const version = internalDb.prepare('PRAGMA user_version').get() as { user_version: number }

            expect(table?.name).toBe('notification_preferences')
            expect(version.user_version).toBe(22)
            expect(store.notificationPrefs.getPreferenceFlags('default')).toEqual({
                permissionRequests: 1,
                sessionReady: 1,
                taskNotifications: 1,
                sessionCompletion: 1
            })
        } finally {
            store?.close()
            rmSync(directory, { recursive: true, force: true })
        }
    })
})
