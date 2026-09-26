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

describe('schema migration v27 to v28', () => {
    it('adds the attachment deletion journal table', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v27-'))
        tempDirs.push(dir)
        const dbPath = join(dir, 'hapi.db')
        const attachmentsRoot = join(dir, 'attachments')

        new Store(dbPath, { attachmentsRoot }).close()
        const legacy = new Database(dbPath)
        legacy.exec('PRAGMA user_version = 27;')
        legacy.close()

        const migrated = new Store(dbPath, { attachmentsRoot })
        const internalDb = (migrated as unknown as { db: Database }).db
        const table = internalDb.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'attachment_deletions'"
        ).get() as { name: string } | null
        const columns = internalDb.prepare('PRAGMA table_info(attachment_deletions)').all() as Array<{ name: string }>
        const version = internalDb.prepare('PRAGMA user_version').get() as { user_version: number }

        expect(table?.name).toBe('attachment_deletions')
        expect(columns.map((column) => column.name)).toEqual(['original_path'])
        expect(version.user_version).toBe(28)
        migrated.close()
    })
})
