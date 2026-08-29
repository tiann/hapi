import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getUsageSummary } from '../sync/usageService'
import { Store } from './index'

describe('Store V25→V26 migration: ACP usage columns', () => {
    it('upgrades a base V25 database before the usage scan', () => {
        const directory = mkdtempSync(join(tmpdir(), 'hapi-migration-v25-to-v26-'))
        const dbPath = join(directory, 'test.db')
        let store: Store | undefined
        try {
            store = new Store(dbPath)
            const session = store.sessions.getOrCreateSession(
                'migration-v25-usage',
                { path: '/tmp', host: 'test', flavor: 'claude' },
                null,
                'default'
            )
            store.messages.addMessage(session.id, {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'assistant',
                        message: {
                            id: 'migration-usage-1',
                            usage: { input_tokens: 10, output_tokens: 2 }
                        }
                    }
                }
            })
            store.close()
            store = undefined

            const db = new Database(dbPath, { create: true, readwrite: true, strict: true })
            db.exec(`
                ALTER TABLE usage_events DROP COLUMN context_only;
                ALTER TABLE usage_events DROP COLUMN cost;
                ALTER TABLE usage_events DROP COLUMN cost_currency;
                INSERT INTO usage_events (
                    session_id, source_key, source_seq, created_at, agent, kind,
                    input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens
                ) VALUES (
                    'migration-v25-usage', 'stale', 1, 1, 'claude', 'delta', 1, 1, 0, 0
                );
                INSERT INTO usage_scan_state (session_id, message_epoch, last_seq)
                VALUES ('migration-v25-usage', 0, 1);
                PRAGMA user_version = 25;
            `)
            db.close()

            store = new Store(dbPath)
            const internalDb = (store as unknown as { db: Database }).db
            const columns = new Set(
                (internalDb.prepare('PRAGMA table_info(usage_events)').all() as Array<{ name: string }>)
                    .map((column) => column.name)
            )
            const version = internalDb.prepare('PRAGMA user_version').get() as { user_version: number }

            expect(version.user_version).toBe(26)
            expect(columns.has('context_only')).toBe(true)
            expect(columns.has('cost')).toBe(true)
            expect(columns.has('cost_currency')).toBe(true)
            expect((internalDb.prepare('SELECT COUNT(*) AS count FROM usage_events').get() as { count: number }).count).toBe(0)
            expect((internalDb.prepare('SELECT COUNT(*) AS count FROM usage_scan_state').get() as { count: number }).count).toBe(0)

            const summary = getUsageSummary(store, 'default', 'all')
            expect(summary.totals.requests).toBe(1)
            expect(summary.totals.inputTokens).toBe(10)
            expect(summary.totals.outputTokens).toBe(2)
        } finally {
            store?.close()
            rmSync(directory, { recursive: true, force: true })
        }
    })

    it('rebuilds stale usage indexes when a v25 database already has the new columns', () => {
        const directory = mkdtempSync(join(tmpdir(), 'hapi-migration-v25-recovery-'))
        const dbPath = join(directory, 'test.db')
        let store: Store | undefined
        try {
            store = new Store(dbPath)
            const session = store.sessions.getOrCreateSession(
                'migration-v25-recovery',
                { path: '/tmp', host: 'test', flavor: 'claude' },
                null,
                'default'
            )
            store.close()
            store = undefined

            const db = new Database(dbPath, { create: true, readwrite: true, strict: true })
            db.exec(`
                INSERT INTO usage_events (
                    session_id, source_key, source_seq, created_at, agent, kind,
                    input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
                    context_only, cost, cost_currency
                ) VALUES (
                    '${session.id}', 'stale', 1, 1, 'claude', 'delta',
                    1, 1, 0, 0, 0, 2.5, 'USD'
                );
                INSERT INTO usage_scan_state (session_id, message_epoch, last_seq)
                VALUES ('${session.id}', 0, 1);
                PRAGMA user_version = 25;
            `)
            db.close()

            store = new Store(dbPath)
            const internalDb = (store as unknown as { db: Database }).db
            const version = internalDb.prepare('PRAGMA user_version').get() as { user_version: number }

            expect(version.user_version).toBe(26)
            expect((internalDb.prepare('SELECT COUNT(*) AS count FROM usage_events').get() as { count: number }).count).toBe(0)
            expect((internalDb.prepare('SELECT COUNT(*) AS count FROM usage_scan_state').get() as { count: number }).count).toBe(0)
        } finally {
            store?.close()
            rmSync(directory, { recursive: true, force: true })
        }
    })
})
