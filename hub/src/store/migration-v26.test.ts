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

describe('schema migration v26 to v28', () => {
    it('adds the durable attachments table to an existing V26 database', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v26-'))
        tempDirs.push(dir)
        const dbPath = join(dir, 'hapi.db')
        const attachmentsRoot = join(dir, 'attachments')

        new Store(dbPath, { attachmentsRoot }).close()
        const legacy = new Database(dbPath)
        legacy.exec('DROP TABLE attachments; PRAGMA user_version = 26;')
        legacy.close()

        const migrated = new Store(dbPath, { attachmentsRoot })
        const internalDb = (migrated as unknown as { db: Database }).db
        const table = internalDb.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'attachments'"
        ).get() as { name: string } | null
        const columns = internalDb.prepare('PRAGMA table_info(attachments)').all() as Array<{ name: string }>
        const version = internalDb.prepare('PRAGMA user_version').get() as { user_version: number }

        expect(table?.name).toBe('attachments')
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
        expect(version.user_version).toBe(28)
        migrated.close()
    })
})
