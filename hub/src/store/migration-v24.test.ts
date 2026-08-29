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
    it('adds ACP usage fields and the iOS push key to a V23 database', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v24-'))
        tempDirs.push(dir)
        const dbPath = join(dir, 'hapi.db')

        new Store(dbPath).close()
        const legacy = new Database(dbPath)
        legacy.exec(`
            ALTER TABLE usage_events DROP COLUMN context_only;
            ALTER TABLE usage_events DROP COLUMN cost;
            ALTER TABLE usage_events DROP COLUMN cost_currency;
            ALTER TABLE fcm_devices DROP COLUMN push_key;
            INSERT INTO fcm_devices (namespace, token, platform, device_id, created_at, updated_at)
            VALUES ('default', 'fcm-tok-1', 'phone', 'pixel-1', 1, 1);
        `)
        // Seed v23-shaped derived data: the upgrade must wipe it so the lazy
        // re-index rebuilds every row under the new semantics.
        legacy.prepare(`
            INSERT INTO usage_events (
                session_id, source_key, source_seq, created_at, agent, model, kind,
                input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens
            ) VALUES (
                'migration-v24-seed', 'delta|seed', 1, 0, 'opencode', NULL, 'delta',
                100, 20, 0, 0
            )
        `).run()
        legacy.exec('PRAGMA user_version = 23')
        legacy.close()

        const migrated = new Store(dbPath)
        const internalDb = (migrated as unknown as { db: Database }).db
        const usageColumns = new Set(
            (internalDb.prepare('PRAGMA table_info(usage_events)').all() as Array<{ name: string }>)
                .map((column) => column.name)
        )
        const fcmColumns = internalDb.prepare('PRAGMA table_info(fcm_devices)').all() as Array<{ name: string }>
        const messageColumns = internalDb.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>
        const version = internalDb.prepare('PRAGMA user_version').get() as { user_version: number }

        expect(usageColumns.has('context_only')).toBe(true)
        expect(usageColumns.has('cost')).toBe(true)
        expect(usageColumns.has('cost_currency')).toBe(true)
        expect(fcmColumns.some((column) => column.name === 'push_key')).toBe(true)
        expect(messageColumns.some((column) => column.name === 'delivery_state')).toBe(true)
        expect(version.user_version).toBe(26)

        const seedCount = internalDb.prepare("SELECT COUNT(*) AS n FROM usage_events WHERE session_id = 'migration-v24-seed'").get() as { n: number }
        expect(seedCount.n).toBe(0)

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

    it('completes either V24 schema shape before adding delivery state', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v24-delivery-'))
        tempDirs.push(dir)
        const dbPath = join(dir, 'hapi.db')

        new Store(dbPath).close()
        const legacy = new Database(dbPath)
        legacy.exec(`
            ALTER TABLE usage_events DROP COLUMN context_only;
            ALTER TABLE usage_events DROP COLUMN cost;
            ALTER TABLE usage_events DROP COLUMN cost_currency;
            ALTER TABLE fcm_devices DROP COLUMN push_key;
            ALTER TABLE messages DROP COLUMN delivery_state;
            PRAGMA user_version = 24;
        `)
        legacy.close()

        const migrated = new Store(dbPath)
        const internalDb = (migrated as unknown as { db: Database }).db
        const usageColumns = internalDb.prepare('PRAGMA table_info(usage_events)').all() as Array<{ name: string }>
        const fcmColumns = internalDb.prepare('PRAGMA table_info(fcm_devices)').all() as Array<{ name: string }>
        const messageColumns = internalDb.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>
        const version = internalDb.prepare('PRAGMA user_version').get() as { user_version: number }
        expect(usageColumns.some((column) => column.name === 'context_only')).toBe(true)
        expect(usageColumns.some((column) => column.name === 'cost')).toBe(true)
        expect(usageColumns.some((column) => column.name === 'cost_currency')).toBe(true)
        expect(fcmColumns.some((column) => column.name === 'push_key')).toBe(true)
        expect(messageColumns.some((column) => column.name === 'delivery_state')).toBe(true)
        expect(version.user_version).toBe(26)
        migrated.close()
    })
})
