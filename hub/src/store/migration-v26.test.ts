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

describe('schema migration v26 to v31', () => {
    it('adds an index used by the session-list future-scheduled lookups', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v26-'))
        tempDirs.push(dir)
        const dbPath = join(dir, 'hapi.db')

        new Store(dbPath).close()
        const legacy = new Database(dbPath)
        legacy.exec(`
            DROP INDEX idx_messages_future_scheduled_queued;
            PRAGMA user_version = 26;
        `)
        legacy.close()

        const migrated = new Store(dbPath)
        const internalDb = (migrated as unknown as { db: Database }).db
        const versionStatement = internalDb.prepare('PRAGMA user_version')
        const version = versionStatement.get() as { user_version: number }
        versionStatement.finalize()
        const countPlanStatement = internalDb.prepare(`
            EXPLAIN QUERY PLAN
            SELECT session_id, COUNT(*) FROM messages
            WHERE session_id IN (?, ?)
              AND invoked_at IS NULL
              AND local_id IS NOT NULL
              AND scheduled_at IS NOT NULL
              AND scheduled_at > ?
              AND delivery_state = 'queued'
            GROUP BY session_id
        `)
        const countPlan = countPlanStatement.all('a', 'b', 123) as Array<{ detail: string }>
        countPlanStatement.finalize()
        const minPlanStatement = internalDb.prepare(`
            EXPLAIN QUERY PLAN
            SELECT session_id, MIN(scheduled_at) FROM messages
            WHERE session_id IN (?, ?)
              AND invoked_at IS NULL
              AND local_id IS NOT NULL
              AND scheduled_at IS NOT NULL
              AND scheduled_at > ?
              AND delivery_state = 'queued'
            GROUP BY session_id
        `)
        const minPlan = minPlanStatement.all('a', 'b', 123) as Array<{ detail: string }>
        minPlanStatement.finalize()

        expect(version.user_version).toBe(31)
        expect(countPlan.some((row) => row.detail.includes('idx_messages_future_scheduled_queued'))).toBe(true)
        expect(minPlan.some((row) => row.detail.includes('idx_messages_future_scheduled_queued'))).toBe(true)
        migrated.close()
    })

    it('adds durable attachment tables to an existing V29 database', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v29-attachments-'))
        tempDirs.push(dir)
        const dbPath = join(dir, 'hapi.db')
        const attachmentsRoot = join(dir, 'attachments')

        new Store(dbPath, { attachmentsRoot }).close()
        const legacy = new Database(dbPath)
        legacy.exec(`
            DROP TABLE attachment_deletions;
            DROP TABLE attachments;
            PRAGMA user_version = 29;
        `)
        legacy.close()

        const migrated = new Store(dbPath, { attachmentsRoot })
        const internalDb = (migrated as unknown as { db: Database }).db
        const table = internalDb.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'attachments'"
        ).get() as { name: string } | null
        const deletions = internalDb.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'attachment_deletions'"
        ).get() as { name: string } | null
        const columns = internalDb.prepare('PRAGMA table_info(attachments)').all() as Array<{ name: string }>
        const version = internalDb.prepare('PRAGMA user_version').get() as { user_version: number }

        expect(table?.name).toBe('attachments')
        expect(deletions?.name).toBe('attachment_deletions')
        expect(columns.map((column) => column.name)).toEqual([
            'id',
            'namespace',
            'session_id',
            'filename',
            'mime_type',
            'size',
            'sha256',
            'original_path',
            'created_at'
        ])
        expect(version.user_version).toBe(31)
        migrated.close()
    })
})
