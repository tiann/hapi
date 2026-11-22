import { expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SCHEMA_VERSION, Store } from '.'

const TELEMETRY_TABLES = [
    'telemetry_events',
    'perf_samples',
    'perf_sse_episodes',
    'perf_web_vitals',
    'perf_rollup_daily',
    'perf_deploy_marks'
] as const

it('creates the telemetry tables on a fresh database', () => {
    const store = new Store(':memory:')
    try {
        const db = (store as unknown as { db: Database }).db
        const rows = db.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ("
            + TELEMETRY_TABLES.map(() => '?').join(', ') + ')'
        ).all(...TELEMETRY_TABLES) as Array<{ name: string }>
        expect(rows.map((row) => row.name).sort()).toEqual([...TELEMETRY_TABLES].sort())
        store.telemetry.recordDeployMark('hub-start', 'test')
        expect(
            (db.prepare('SELECT COUNT(*) AS n FROM perf_deploy_marks').get() as { n: number }).n
        ).toBe(1)
    } finally {
        store.close()
    }
})

it('adds the telemetry family when upgrading a v36 database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hapi-telemetry-v37-migration-'))
    try {
        const path = join(dir, 'hub.db')
        new Store(path).close()
        const legacy = new Database(path)
        legacy.exec(
            TELEMETRY_TABLES.map((table) => `DROP TABLE ${table};`).join(' ')
            + ' PRAGMA user_version = 36;'
        )
        legacy.close()
        const migrated = new Store(path)
        try {
            const db = (migrated as unknown as { db: Database }).db
            expect(
                (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
            ).toBe(SCHEMA_VERSION)
            // Ingest works end-to-end on the migrated schema.
            const result = migrated.telemetry.insertBatch(
                { namespace: 'default', userId: 1, level: 1 },
                {
                    schema: 1,
                    device: { id: 'd', kind: 'browser', origin: 'local' },
                    appVersion: 't',
                    events: [{
                        id: 'm-1',
                        ts: Date.now(),
                        seq: 1,
                        domain: 'ux',
                        kind: 'session_open',
                        level: 1,
                        data: { entry: 'url-direct', openedAt: Date.now() }
                    }]
                }
            )
            expect(result.accepted).toBe(1)
        } finally {
            migrated.close()
        }
    } finally {
        Bun.gc(true)
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
})
