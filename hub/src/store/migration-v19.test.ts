import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from './index'
import { getUsageSummary } from '../sync/usageService'

describe('Store V19->current migration: usage re-index', () => {
    it('clears stale derived usage rows and scan state', () => {
        const directory = mkdtempSync(join(tmpdir(), 'hapi-migration-v19-to-v20-'))
        const dbPath = join(directory, 'test.db')
        let store: Store | undefined
        try {
            store = new Store(dbPath)
            store.close()
            store = undefined

            const db = new Database(dbPath, { create: true, readwrite: true, strict: true })
            db.exec(`
                INSERT INTO sessions (id, created_at, updated_at)
                VALUES ('session-1', 1, 1);
                INSERT INTO usage_events (
                    session_id, source_key, source_seq, created_at, agent, kind
                ) VALUES (
                    'session-1', 'legacy-key', 1, 1, 'codex', 'cumulative'
                );
                INSERT INTO usage_scan_state (session_id, message_epoch, last_seq)
                VALUES ('session-1', 1, 42);
                PRAGMA user_version = 19;
            `)
            db.close()

            store = new Store(dbPath)
            const internalDb = (store as unknown as { db: Database }).db
            const version = internalDb.prepare('PRAGMA user_version').get() as { user_version: number }
            const scanRows = internalDb.prepare('SELECT COUNT(*) AS count FROM usage_scan_state').get() as { count: number }
            const usageRows = internalDb.prepare('SELECT COUNT(*) AS count FROM usage_events').get() as { count: number }

            expect(version.user_version).toBe(25)
            expect(scanRows.count).toBe(0)
            expect(usageRows.count).toBe(0)
        } finally {
            store?.close()
            rmSync(directory, { recursive: true, force: true })
        }
    })

    it('re-indexes legacy unknown-model events with the session model fallback', () => {
        const directory = mkdtempSync(join(tmpdir(), 'hapi-migration-v19-to-v20-reindex-'))
        const dbPath = join(directory, 'test.db')
        let store: Store | undefined
        try {
            store = new Store(dbPath)
            const session = store.sessions.getOrCreateSession(
                'session-1',
                { path: '/tmp', host: 'test', flavor: 'codex' },
                null,
                'default',
                'gpt-test'
            )
            store.messages.addMessage(session.id, {
                role: 'agent',
                content: {
                    type: 'codex',
                    data: {
                        type: 'token_count',
                        thread_id: 'thread-1',
                        turn_id: 'turn-1',
                        info: {
                            total_token_usage: { input_tokens: 100, output_tokens: 10 },
                            last_token_usage: { input_tokens: 100, output_tokens: 10 }
                        }
                    }
                }
            })
            expect(getUsageSummary(store, 'default', 'all').totals.requests).toBe(1)
            store.close()
            store = undefined

            // Simulate the pre-#1359 state: derived rows without model
            // attribution and a scan state that blocks any re-index.
            const db = new Database(dbPath, { create: true, readwrite: true, strict: true })
            db.exec(`
                UPDATE usage_events SET model = NULL;
                PRAGMA user_version = 19;
            `)
            db.close()

            store = new Store(dbPath)
            const result = getUsageSummary(store, 'default', 'all')
            expect(result.totals.requests).toBe(1)
            expect(result.byModel).toEqual([
                expect.objectContaining({ key: 'gpt-test', totalTokens: 110 })
            ])
        } finally {
            store?.close()
            rmSync(directory, { recursive: true, force: true })
        }
    })
})
