import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertDurableSQLiteMode, Store } from './index'

const homes: string[] = []
afterEach(() => homes.splice(0).forEach((home) => rmSync(home, { recursive: true, force: true })))

describe('Store durability', () => {
    it('uses FULL synchronous WAL commits for acknowledged delivery and outcome barriers', () => {
        const store = new Store(':memory:')
        const db = (store.deliveryAttempts as unknown as { db: { prepare: (sql: string) => { get: () => unknown } } }).db

        expect(db.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'memory' })
        expect(db.prepare('PRAGMA synchronous').get()).toMatchObject({ synchronous: 2 })
    })

    it('negotiates and verifies WAL with FULL synchronous commits on a file-backed database', () => {
        const home = mkdtempSync(join(tmpdir(), 'hapi-store-durability-'))
        homes.push(home)
        const store = new Store(join(home, 'hapi.db'))
        const db = (store.deliveryAttempts as unknown as { db: { prepare: (sql: string) => { get: () => unknown }; close: () => void } }).db

        expect(db.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' })
        expect(db.prepare('PRAGMA synchronous').get()).toMatchObject({ synchronous: 2 })
        db.close()
    })

    it('fails closed when a file-backed database does not actually negotiate WAL and FULL', () => {
        expect(() => assertDurableSQLiteMode('delete', 2, false)).toThrow('WAL')
        expect(() => assertDurableSQLiteMode('wal', 1, false)).toThrow('FULL')
        expect(() => assertDurableSQLiteMode('memory', 2, true)).not.toThrow()
    })
})
