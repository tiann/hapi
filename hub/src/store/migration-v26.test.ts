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

describe('schema migration v26 to v27', () => {
    it('adds reply-clock columns to an already-v26 database', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v26-'))
        tempDirs.push(dir)
        const dbPath = join(dir, 'hapi.db')

        const initial = new Store(dbPath)
        initial.sessions.getOrCreateSession(
            'migration-v26-reply-clock',
            { path: '/tmp/project', host: 'localhost' },
            null,
            'default'
        )
        initial.close()

        const legacy = new Database(dbPath)
        legacy.exec(`
            ALTER TABLE sessions DROP COLUMN assistant_reply_clock_backfilled;
            ALTER TABLE sessions DROP COLUMN last_assistant_message_at;
            PRAGMA user_version = 26;
        `)
        legacy.close()

        const migrated = new Store(dbPath)
        try {
            const internalDb = (migrated as unknown as { db: Database }).db
            const columns = internalDb
                .prepare('PRAGMA table_info(sessions)')
                .all() as Array<{ name: string }>

            expect(columns.some((column) => column.name === 'last_assistant_message_at')).toBe(true)
            expect(columns.some((column) => column.name === 'assistant_reply_clock_backfilled')).toBe(true)
            expect(internalDb.prepare('PRAGMA user_version').get() as { user_version: number })
                .toEqual({ user_version: 27 })

            const session = migrated.sessions.getOrCreateSession(
                'post-v26-session',
                { path: '/tmp/project', host: 'localhost' },
                null,
                'default'
            )
            const message = migrated.messages.addMessage(session.id, {
                role: 'agent',
                content: { type: 'codex', data: { type: 'message', message: 'reply after migration' } }
            })

            expect(message.id).toBeString()
            expect(migrated.sessions.getSession(session.id)?.lastAssistantMessageAt).toBeGreaterThan(0)
        } finally {
            migrated.close()
        }
    })
})
