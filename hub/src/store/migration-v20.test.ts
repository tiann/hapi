import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getUsageSummary } from '../sync/usageService'
import { Store } from './index'

describe('Store V20->V21 migration: usage semantics re-index', () => {
    it('clears both derived tables, preserves messages, and lazily rebuilds idempotently', () => {
        const directory = mkdtempSync(join(tmpdir(), 'hapi-migration-v20-to-v21-'))
        const dbPath = join(directory, 'test.db')
        let store: Store | undefined
        try {
            store = new Store(dbPath)
            const session = store.sessions.getOrCreateSession(
                'session-1',
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
                            id: 'usage-1',
                            usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 80 }
                        }
                    }
                }
            })
            expect(getUsageSummary(store, 'default', 'all').totals.inputTokens).toBe(90)
            store.close()
            store = undefined

            const db = new Database(dbPath, { create: true, readwrite: true, strict: true })
            db.exec('PRAGMA user_version = 20;')
            db.close()

            store = new Store(dbPath)
            const internalDb = (store as unknown as { db: Database }).db
            const count = (table: string): number => (internalDb.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count
            expect((internalDb.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(25)
            expect(count('usage_events')).toBe(0)
            expect(count('usage_scan_state')).toBe(0)
            expect(store.messages.getMessages(session.id)).toHaveLength(1)

            const first = getUsageSummary(store, 'default', 'all')
            expect(first.totals.inputTokens).toBe(90)
            expect(count('usage_events')).toBe(1)
            expect(count('usage_scan_state')).toBe(1)
            const second = getUsageSummary(store, 'default', 'all')
            expect(second.totals).toEqual(first.totals)
            expect(count('usage_events')).toBe(1)
        } finally {
            store?.close()
            rmSync(directory, { recursive: true, force: true })
        }
    })
})
