import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { prepareCached } from './statementCache'

describe('prepareCached', () => {
    it('reuses one Statement instance per (db, sql) and keeps it bindable', () => {
        const db = new Database(':memory:')
        db.exec('CREATE TABLE t (id TEXT)')

        const first = prepareCached(db, 'SELECT COUNT(*) AS n FROM t WHERE id = ?')
        const second = prepareCached(db, 'SELECT COUNT(*) AS n FROM t WHERE id = ?')
        expect(second).toBe(first)

        expect((first.get('x') as { n: number }).n).toBe(0)
        db.exec("INSERT INTO t VALUES ('x')")
        expect((second.get('x') as { n: number }).n).toBe(1)
        expect((prepareCached(db, 'SELECT COUNT(*) AS n FROM t WHERE id = ?').get('x') as { n: number }).n).toBe(1)
        db.close()
    })

    it('caches per Database instance', () => {
        const db1 = new Database(':memory:')
        const db2 = new Database(':memory:')
        for (const db of [db1, db2]) db.exec('CREATE TABLE t (id TEXT)')

        expect(prepareCached(db1, 'SELECT COUNT(*) FROM t')).not.toBe(prepareCached(db2, 'SELECT COUNT(*) FROM t'))
        db1.close()
        db2.close()
    })

    it('does not share statements across distinct sql on the same db', () => {
        const db = new Database(':memory:')
        db.exec('CREATE TABLE t (id TEXT)')
        expect(prepareCached(db, 'SELECT COUNT(*) FROM t')).not.toBe(prepareCached(db, 'SELECT id FROM t'))
        db.close()
    })

    it('bounds retention: beyond the cap statements are prepared per call', () => {
        const db = new Database(':memory:')
        db.exec('CREATE TABLE t (id TEXT)')

        // Warm an entry while the cache is below its cap.
        const early = prepareCached(db, 'SELECT COUNT(*) AS n FROM t')

        // Flood past the retention bound with distinct constant SQL.
        for (let i = 0; i < 600; i += 1) {
            prepareCached(db, `SELECT ${i} AS n`)
        }

        // Entries admitted before the cap stay cached (identity stable).
        expect(prepareCached(db, 'SELECT COUNT(*) AS n FROM t')).toBe(early)

        // New statements beyond the cap are not retained: each call compiles
        // its own statement, and both execute correctly.
        const lateA = prepareCached(db, 'SELECT 4242 AS n')
        const lateB = prepareCached(db, 'SELECT 4242 AS n')
        expect(lateA).not.toBe(lateB)
        expect((lateA.get() as { n: number }).n).toBe(4242)
        expect((lateB.get() as { n: number }).n).toBe(4242)
        db.close()
    })
})
