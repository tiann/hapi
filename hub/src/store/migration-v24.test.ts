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
    it('adds fcm_devices.push_key to a V23 database and keeps existing rows', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v24-'))
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
        expect(version.user_version).toBe(26)
        migrated.close()
    })
})

describe('schema migration v24 to v26', () => {
    it('adds the assistant reply clock and preserves activity time', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-reply-clock-'))
        tempDirs.push(dir)
        const dbPath = join(dir, 'hapi.db')

        const initial = new Store(dbPath)
        const session = initial.sessions.getOrCreateSession(
            'migration-reply-clock',
            { path: '/tmp/project', host: 'localhost' },
            null,
            'default'
        )
        const activityAt = session.updatedAt
        initial.close()

        const legacy = new Database(dbPath)
        legacy.exec('ALTER TABLE sessions DROP COLUMN assistant_reply_clock_backfilled')
        legacy.exec('ALTER TABLE sessions DROP COLUMN last_assistant_message_at')
        legacy.exec('PRAGMA user_version = 24')
        legacy.close()

        const migrated = new Store(dbPath)
        const internalDb = (migrated as unknown as { db: Database }).db
        const columns = internalDb
            .prepare('PRAGMA table_info(sessions)')
            .all() as Array<{ name: string }>

        expect(columns.some((column) => column.name === 'last_assistant_message_at')).toBe(true)
        expect(columns.some((column) => column.name === 'assistant_reply_clock_backfilled')).toBe(true)
        expect(internalDb.prepare('PRAGMA user_version').get() as { user_version: number })
            .toEqual({ user_version: 26 })

        const reloaded = migrated.sessions.getSession(session.id)
        expect(reloaded?.lastAssistantMessageAt).toBeNull()
        expect(reloaded?.assistantReplyClockBackfilled).toBe(false)
        expect(reloaded?.updatedAt).toBe(activityAt)
        migrated.close()
    })
})
