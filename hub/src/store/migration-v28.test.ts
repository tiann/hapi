import { afterEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from './index'

const tempDirs: string[] = []

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true })
    }
})

describe('schema migration v28 to v29', () => {
    it('adds the attachment creation journal table', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v28-'))
        tempDirs.push(dir)
        const dbPath = join(dir, 'hapi.db')
        const attachmentsRoot = join(dir, 'attachments')

        new Store(dbPath, { attachmentsRoot }).close()
        const legacy = new Database(dbPath)
        legacy.exec(`
            ALTER TABLE attachment_creations RENAME TO attachment_creations_legacy;
            PRAGMA user_version = 28;
        `)
        legacy.close()

        const migrated = new Store(dbPath, { attachmentsRoot })
        const internalDb = (migrated as unknown as { db: Database }).db
        const columns = internalDb.prepare('PRAGMA table_info(attachment_creations)').all() as Array<{ name: string }>
        const version = internalDb.prepare('PRAGMA user_version').get() as { user_version: number }

        expect(columns.map((column) => column.name)).toEqual([
            'id', 'namespace', 'session_id', 'original_path', 'temp_path',
            'state', 'created_at', 'resolved_at'
        ])
        expect(version.user_version).toBe(29)
        migrated.close()
    })
})
