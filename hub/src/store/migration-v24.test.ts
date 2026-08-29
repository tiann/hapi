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

describe('schema migration v23 to v26', () => {
    it('adds the durable attachments table when upgrading a V25 database', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v25-'))
        tempDirs.push(dir)
        const dbPath = join(dir, 'hapi.db')

        new Store(dbPath, { attachmentsRoot: join(dir, 'attachments') }).close()
        const legacy = new Database(dbPath)
        legacy.exec('DROP TABLE IF EXISTS attachments; PRAGMA user_version = 25;')
        legacy.close()

        const migrated = new Store(dbPath, { attachmentsRoot: join(dir, 'attachments') })
        const internalDb = (migrated as unknown as { db: Database }).db
        const table = internalDb.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'attachments'"
        ).get() as { name: string } | null
        const columns = internalDb.prepare('PRAGMA table_info(attachments)').all() as Array<{ name: string }>
        const version = internalDb.prepare('PRAGMA user_version').get() as { user_version: number }

        expect(table?.name).toBe('attachments')
        expect(columns.map((column) => column.name)).not.toContain('thumbnail_path')
        expect(version.user_version).toBe(26)
        migrated.close()
    })

    it('adds fcm_devices.push_key to a V23 database and keeps existing rows', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v24-fcm-'))
        tempDirs.push(dir)
        const dbPath = join(dir, 'hapi.db')

        new Store(dbPath).close()
        const legacy = new Database(dbPath)
        legacy.exec(`
            ALTER TABLE fcm_devices DROP COLUMN push_key;
            INSERT INTO fcm_devices (namespace, token, platform, device_id, created_at, updated_at)
            VALUES ('default', 'fcm-tok-1', 'phone', 'pixel-1', 1, 1);
            PRAGMA user_version = 23;
        `)
        legacy.close()

        const migrated = new Store(dbPath)
        const internalDb = (migrated as unknown as { db: Database }).db
        const columns = internalDb.prepare('PRAGMA table_info(fcm_devices)').all() as Array<{ name: string }>
        const version = internalDb.prepare('PRAGMA user_version').get() as { user_version: number }

        expect(columns.some((col) => col.name === 'push_key')).toBe(true)
        const messageColumns = internalDb.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>
        expect(messageColumns.some((col) => col.name === 'delivery_state')).toBe(true)
        expect(version.user_version).toBe(26)

        // Existing Android rows survive with a NULL push key.
        const devices = migrated.fcm.getDevicesByNamespace('default')
        expect(devices).toHaveLength(1)
        expect(devices[0].token).toBe('fcm-tok-1')
        expect(devices[0].pushKey).toBeNull()

        // And the migrated DB accepts new iOS rows.
        migrated.fcm.upsertDevice('default', {
            token: 'a1b2',
            platform: 'ios',
            deviceId: 'iphone-1',
            pushKey: Buffer.alloc(32, 7).toString('base64')
        })
        expect(migrated.fcm.getDevicesByNamespace('default', ['ios'])).toHaveLength(1)
        migrated.close()
    })

    it('adds messages.delivery_state to an already-upgraded V24 database', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v24-delivery-'))
        tempDirs.push(dir)
        const dbPath = join(dir, 'hapi.db')

        new Store(dbPath).close()
        const legacy = new Database(dbPath)
        legacy.exec(`
            ALTER TABLE messages DROP COLUMN delivery_state;
            PRAGMA user_version = 24;
        `)
        legacy.close()

        const migrated = new Store(dbPath)
        const internalDb = (migrated as unknown as { db: Database }).db
        const columns = internalDb.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>
        const version = internalDb.prepare('PRAGMA user_version').get() as { user_version: number }
        expect(columns.some((col) => col.name === 'delivery_state')).toBe(true)
        const attachmentTable = internalDb.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'attachments'"
        ).get() as { name: string } | null
        expect(attachmentTable?.name).toBe('attachments')
        expect(version.user_version).toBe(26)
        migrated.close()
    })
})
