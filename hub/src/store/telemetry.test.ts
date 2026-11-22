import { afterEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TelemetryBatch, TelemetryEvent } from '@hapi/protocol/telemetry'
import { Store } from './index'
import { writeTelemetryLevel } from '../config/telemetryLevel'
import { __resetSettingsReadCacheForTests, getSettingsFile } from '../config/settings'
import {
    insertTelemetryBatch,
    nearestRankPercentile,
    recordHubPerfSample,
    hubPerfQueueStats,
    perfRawWindowHours,
    recordDeployMark,
    refreshHubTelemetryLevel,
    sweepTelemetry,
    seedTodayDirtyBuckets,
    tickTelemetry,
    resolveHubVersion,
    PERF_QUEUE_CAP_FOR_TESTS
} from './telemetry'

const DAY = 86_400_000

function uxEvent(id: string, ts: number, sessionId?: string): TelemetryEvent {
    return {
        id,
        ts,
        seq: 1,
        domain: 'ux',
        kind: 'session_open',
        level: 1,
        sessionId,
        data: { entry: 'list-click', openedAt: ts }
    }
}

function httpEvent(id: string, ts: number, totalMs: number, overrides?: {
    status?: number
    pathTpl?: string
    method?: string
    originKind?: string
}): TelemetryEvent {
    return {
        id,
        ts,
        seq: 2,
        domain: 'perf',
        kind: 'http',
        level: 1,
        data: {
            method: overrides?.method ?? 'GET',
            pathTpl: overrides?.pathTpl ?? '/api/sessions',
            status: overrides?.status ?? 200,
            totalMs,
            ...(overrides?.originKind ? { originKind: overrides.originKind } : {})
        }
    }
}

function sseEpisodeEvent(id: string, ts: number): TelemetryEvent {
    return {
        id,
        ts,
        seq: 3,
        domain: 'perf',
        kind: 'sse_episode',
        level: 1,
        data: { durationMs: 1_200, eventsCount: 40, bytesSent: 8_000, gapMs: 250, resume: 'gap', subscriptionId: 'sub-1' }
    }
}

function webVitalEvent(id: string, ts: number): TelemetryEvent {
    return {
        id,
        ts,
        seq: 4,
        domain: 'perf',
        kind: 'web_vital',
        level: 2,
        data: { lcpMs: 2_400, inpP75Ms: 180, longTasks: 3 }
    }
}

function batch(events: TelemetryEvent[]): TelemetryBatch {
    return {
        schema: 1,
        device: { id: 'dev-1', kind: 'browser', origin: 'direct' },
        appVersion: '0.36.5-test',
        events
    }
}

function rawDb(store: Store): Database {
    return (store as unknown as { db: Database }).db
}

// Hub-plane level gate (review finding #1): temp settings roots used to prime
// the cached level; cleaned up in afterEach.
const levelDirs: string[] = []

async function primeLevel(db: Database, level: 0 | 1 | 2 | 3): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'hapi-tel-level-'))
    levelDirs.push(dir)
    await writeTelemetryLevel(dir, level)
    await refreshHubTelemetryLevel(db, dir)
    return dir
}

afterEach(async () => {
    await Promise.all(levelDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('insertTelemetryBatch', () => {
    it('splits events into the right tables and stamps server fields', () => {
        const store = new Store(':memory:')
        try {
            const ts = Date.now()
            const result = insertTelemetryBatch(
                rawDb(store),
                { namespace: 'default', userId: 7, level: 2 },
                batch([
                    uxEvent('evt-1', ts, 'sess-1'),
                    httpEvent('evt-2', ts, 220),
                    sseEpisodeEvent('evt-3', ts),
                    webVitalEvent('evt-4', ts)
                ])
            )
            expect(result).toEqual({ accepted: 4, rejected: 0, droppedByLevel: 0 })

            const db = rawDb(store)
            const events = db.prepare('SELECT * FROM telemetry_events').all() as Array<Record<string, unknown>>
            expect(events).toHaveLength(1)
            expect(events[0]).toMatchObject({
                id: 'evt-1',
                namespace: 'default',
                user_id: '7',
                device_id: 'dev-1',
                device_kind: 'browser',
                origin_kind: 'direct',
                domain: 'ux',
                kind: 'session_open',
                session_id: 'sess-1',
                hub_version: resolveHubVersion(),
                web_version: '0.36.5-test'
            })

            const samples = db.prepare('SELECT * FROM perf_samples').all() as Array<Record<string, unknown>>
            expect(samples).toHaveLength(1)
            expect(samples[0]).toMatchObject({
                source: 'web',
                method: 'GET',
                path_tpl: '/api/sessions',
                status: 200,
                total_ms: 220,
                namespace: 'default'
            })

            const episodes = db.prepare('SELECT * FROM perf_sse_episodes').all() as Array<Record<string, unknown>>
            expect(episodes).toHaveLength(1)
            expect(episodes[0]).toMatchObject({
                source: 'web',
                subscription_id: 'sub-1',
                duration_ms: 1_200,
                events_count: 40,
                bytes_sent: 8_000,
                gap_ms: 250,
                replay_events: null
            })

            const vitals = db.prepare('SELECT * FROM perf_web_vitals').all() as Array<Record<string, unknown>>
            expect(vitals).toHaveLength(1)
            expect(vitals[0]).toMatchObject({ lcp_ms: 2_400, inp_p75_ms: 180, long_tasks: 3 })
        } finally {
            store.close()
        }
    })

    it('is idempotent on the client event id (re-delivery inserts one row)', () => {
        const store = new Store(':memory:')
        try {
            const db = rawDb(store)
            const ts = Date.now()
            // Mixed batch: telemetry_events dedupes via PRIMARY KEY; perf rows
            // dedupe via the in-memory recent-id guard (the SDK deliberately
            // replays pagehide batches — keepalive POST + outbox copy).
            const events = [uxEvent('same-id', ts, 'sess-1'), httpEvent('perf-same-id', ts, 80)]
            const first = insertTelemetryBatch(db, { namespace: 'default', userId: 1, level: 1 }, batch(events))
            expect(first).toEqual({ accepted: 2, rejected: 0, droppedByLevel: 0 })
            const second = insertTelemetryBatch(db, { namespace: 'default', userId: 1, level: 1 }, batch(events))
            expect(second).toEqual({ accepted: 2, rejected: 0, droppedByLevel: 0 })
            expect(
                (db.prepare('SELECT COUNT(*) AS n FROM telemetry_events').get() as { n: number }).n
            ).toBe(1)
            expect(
                (db.prepare('SELECT COUNT(*) AS n FROM perf_samples').get() as { n: number }).n
            ).toBe(1)
            // A different perf event id still lands normally.
            insertTelemetryBatch(db, { namespace: 'default', userId: 1, level: 1 }, batch([httpEvent('perf-other', ts, 90)]))
            expect(
                (db.prepare('SELECT COUNT(*) AS n FROM perf_samples').get() as { n: number }).n
            ).toBe(2)
        } finally {
            store.close()
        }
    })

    it('rejects individual events (unknown kind, bad data) without rejecting the batch', () => {
        const store = new Store(':memory:')
        try {
            const db = rawDb(store)
            const ts = Date.now()
            const result = insertTelemetryBatch(db, { namespace: 'default', userId: 1, level: 1 }, batch([
                uxEvent('ok-1', ts),
                { id: 'bad-1', ts, seq: 1, domain: 'ux', kind: 'no-such-kind', level: 1, data: {} },
                { id: 'bad-2', ts, seq: 1, domain: 'ux', kind: 'session_open', level: 1, data: { entry: 'nope', openedAt: 1 } }
            ]))
            expect(result.accepted).toBe(1)
            expect(result.rejected).toBe(2)
            expect(result.droppedByLevel).toBe(0)
        } finally {
            store.close()
        }
    })

    it('drops events whose required level exceeds the configured level and counts them', () => {
        const store = new Store(':memory:')
        try {
            const db = rawDb(store)
            const ts = Date.now()
            const result = insertTelemetryBatch(db, { namespace: 'default', userId: 1, level: 1 }, batch([
                uxEvent('l1-1', ts),
                { id: 'l2-1', ts, seq: 1, domain: 'ux', kind: 'session_pin', level: 2, data: { mode: 'global' } },
                webVitalEvent('l2-2', ts)
            ]))
            expect(result).toEqual({ accepted: 1, rejected: 0, droppedByLevel: 2 })
        } finally {
            store.close()
        }
    })

    it('rejects a poisoned ts (1e300) per event without rolling back the batch (review finding #2)', () => {
        const store = new Store(':memory:')
        try {
            const db = rawDb(store)
            const ts = Date.now()
            // 63 well-formed http samples + 1 poisoned ts=1e300 in the same
            // transaction: the schema range guard rejects just the poisoned
            // event; the batch must not throw, must not roll back.
            const events: TelemetryEvent[] = Array.from({ length: 63 }, (_, i) =>
                httpEvent(`ok-${i}`, ts, i + 1))
            events.push({
                id: 'poison',
                ts: 1e300,
                seq: 99,
                domain: 'perf',
                kind: 'http',
                level: 1,
                data: { method: 'GET', pathTpl: '/api/sessions', status: 200, totalMs: 10 }
            })
            const result = insertTelemetryBatch(db, { namespace: 'default', userId: 1, level: 1 }, batch(events))
            expect(result).toEqual({ accepted: 63, rejected: 1, droppedByLevel: 0 })
            const rows = db.prepare('SELECT COUNT(*) AS n FROM perf_samples').get() as { n: number }
            expect(rows.n).toBe(63)
        } finally {
            store.close()
        }
    })
})

describe('nearestRankPercentile', () => {
    it('matches hand-computed nearest-rank values', () => {
        const oneToTen = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
        expect(nearestRankPercentile(oneToTen, 50)).toBe(50)
        expect(nearestRankPercentile(oneToTen, 95)).toBe(100)
        expect(nearestRankPercentile(oneToTen, 99)).toBe(100)

        const oneToHundred = Array.from({ length: 100 }, (_, i) => i + 1)
        expect(nearestRankPercentile(oneToHundred, 50)).toBe(50)
        expect(nearestRankPercentile(oneToHundred, 95)).toBe(95)
        expect(nearestRankPercentile(oneToHundred, 99)).toBe(99)

        const oneToTwenty = Array.from({ length: 20 }, (_, i) => i + 1)
        expect(nearestRankPercentile(oneToTwenty, 50)).toBe(10)
        expect(nearestRankPercentile(oneToTwenty, 95)).toBe(19)
        expect(nearestRankPercentile(oneToTwenty, 99)).toBe(20)

        expect(nearestRankPercentile([42], 50)).toBe(42)
        expect(nearestRankPercentile([42], 95)).toBe(42)
        expect(nearestRankPercentile([], 95)).toBe(0)
    })
})

describe('hub-plane queue + flusher + rollup', () => {
    it('flushes the queue into perf_samples with normalized paths and hub stamps', async () => {
        const store = new Store(':memory:')
        try {
            const db = rawDb(store)
            await primeLevel(db, 1)
            const now = Date.now()
            recordHubPerfSample(db, {
                ts: now,
                method: 'GET',
                path: '/api/sessions/19c9c827-463d-4c53-9f37-f6a6f1fa6681?page=1',
                status: 200,
                totalMs: 12.4,
                traceId: 'trace-1',
                reqBytes: 0,
                resBytes: 2048,
                namespace: 'default'
            })
            expect(hubPerfQueueStats(db).queued).toBe(1)
            tickTelemetry(db, now + 1_000)
            expect(hubPerfQueueStats(db).queued).toBe(0)

            const rows = db.prepare('SELECT * FROM perf_samples').all() as Array<Record<string, unknown>>
            expect(rows).toHaveLength(1)
            expect(rows[0]).toMatchObject({
                source: 'hub',
                method: 'GET',
                path_tpl: '/api/sessions/:id',
                status: 200,
                total_ms: 12,
                trace_id: 'trace-1',
                res_bytes: 2048,
                namespace: 'default',
                hub_version: resolveHubVersion()
            })
        } finally {
            store.close()
        }
    })

    it('enforces the bounded queue (drop-oldest with a drop counter)', async () => {
        const store = new Store(':memory:')
        try {
            const db = rawDb(store)
            await primeLevel(db, 1)
            const cap = PERF_QUEUE_CAP_FOR_TESTS
            for (let i = 0; i < cap + 10; i++) {
                recordHubPerfSample(db, {
                    ts: Date.now(),
                    method: 'GET',
                    path: `/api/sessions/${i}`,
                    status: 200,
                    totalMs: 1,
                    namespace: 'default'
                })
            }
            const stats = hubPerfQueueStats(db)
            expect(stats.queued).toBe(cap)
            expect(stats.dropped).toBe(10)
        } finally {
            store.close()
        }
    })

    it('gates the hub plane on the telemetry level (review finding #1)', async () => {
        const store = new Store(':memory:')
        try {
            const db = rawDb(store)
            const now = Date.now()
            const sample = {
                ts: now,
                method: 'GET',
                path: '/api/sessions',
                status: 200,
                totalMs: 5,
                namespace: 'default'
            }
            // Default level 0 (opt-in off): the sample never even queues and
            // a flush writes zero rows.
            recordHubPerfSample(db, sample)
            expect(hubPerfQueueStats(db).queued).toBe(0)
            tickTelemetry(db, now + 1_000)
            expect((db.prepare('SELECT COUNT(*) AS n FROM perf_samples').get() as { n: number }).n).toBe(0)

            // Level 1 via refresh → queue + flush work again.
            await primeLevel(db, 1)
            recordHubPerfSample(db, sample)
            expect(hubPerfQueueStats(db).queued).toBe(1)
            tickTelemetry(db, now + 2_000)
            expect(hubPerfQueueStats(db).queued).toBe(0)
            expect((db.prepare('SELECT COUNT(*) AS n FROM perf_samples').get() as { n: number }).n).toBe(1)

            // Unreadable settings on refresh → gate falls back closed (0)
            // and the flusher writes nothing either.
            const dir = await mkdtemp(join(tmpdir(), 'hapi-tel-level-'))
            levelDirs.push(dir)
            await writeFile(getSettingsFile(dir), '{not json', 'utf8')
            __resetSettingsReadCacheForTests()
            await refreshHubTelemetryLevel(db, dir)
            recordHubPerfSample(db, sample)
            expect(hubPerfQueueStats(db).queued).toBe(0)
            tickTelemetry(db, now + 3_000)
            expect((db.prepare('SELECT COUNT(*) AS n FROM perf_samples').get() as { n: number }).n).toBe(1)
        } finally {
            store.close()
        }
    })

    it('tickTelemetry refreshes the cached level every tick (wiring)', async () => {
        const store = new Store(':memory:')
        try {
            const db = rawDb(store)
            tickTelemetry(db, Date.now(), {
                dataDir: '/tmp/whatever',
                readTelemetryLevel: async () => 1
            })
            // Fire-and-forget refresh: let the microtask chain land.
            await new Promise((resolve) => setTimeout(resolve, 0))
            recordHubPerfSample(db, {
                ts: Date.now(),
                method: 'GET',
                path: '/api/sessions',
                status: 200,
                totalMs: 5,
                namespace: 'default'
            })
            expect(hubPerfQueueStats(db).queued).toBe(1)
        } finally {
            store.close()
        }
    })

    it('recomputes dirty day buckets with nearest-rank percentiles', () => {
        const store = new Store(':memory:')
        try {
            const db = rawDb(store)
            const now = Date.now()
            const events = Array.from({ length: 20 }, (_, i) => httpEvent(`perf-${i}`, now, i + 1))
            insertTelemetryBatch(db, { namespace: 'default', userId: 1, level: 1 }, batch(events))
            tickTelemetry(db, now + 1_000)

            const rollup = db.prepare('SELECT * FROM perf_rollup_daily').all() as Array<Record<string, unknown>>
            expect(rollup).toHaveLength(1)
            expect(rollup[0]).toMatchObject({
                source: 'web',
                path_tpl: '/api/sessions',
                method: 'GET',
                status_class: '2xx',
                origin_kind: 'direct',
                sample_count: 20,
                p50_ms: 10,
                p95_ms: 19,
                p99_ms: 20,
                max_ms: 20,
                total_ms_sum: 210
            })
        } finally {
            store.close()
        }
    })

    it('seeds today’s buckets after a restart so rollups survive reboots', () => {
        const store = new Store(':memory:')
        try {
            const db = rawDb(store)
            const now = Date.now()
            // Rows landed by a previous process: no in-memory dirty state here.
            insertTelemetryBatch(db, { namespace: 'default', userId: 1, level: 1 }, batch([httpEvent('p-1', now, 42)]))
            db.exec('DELETE FROM perf_rollup_daily')
            // Simulate the fresh-process path: seed buckets from existing rows,
            // then let the tick recompute them.
            seedTodayDirtyBuckets(db, now)
            tickTelemetry(db, now + 1_000)
            const rollup = db.prepare('SELECT sample_count, p50_ms FROM perf_rollup_daily').all() as Array<Record<string, number>>
            expect(rollup).toEqual([{ sample_count: 1, p50_ms: 42 }])
        } finally {
            store.close()
        }
    })
})

describe('sweepTelemetry retention', () => {
    it('deletes by age window, keeps slow/error tails, and trims to the row cap', async () => {
        const store = new Store(':memory:')
        try {
            const db = rawDb(store)
            await primeLevel(db, 1)
            const now = Date.now()

            // telemetry_events: one fresh, one 15d old (past the 14d fence).
            insertTelemetryBatch(db, { namespace: 'default', userId: 1, level: 1, now }, batch([uxEvent('fresh', now)]))
            insertTelemetryBatch(
                db,
                { namespace: 'default', userId: 1, level: 1, now: now - 15 * DAY },
                batch([uxEvent('ancient', now - 15 * DAY)])
            )

            // perf_samples via the hub queue: fast-2xx past the raw window
            // dies, slow/error rows survive to the 14d tail, 15d rows all die.
            const samples: Array<[number, number, number]> = [
                [now - 3 * DAY, 200, 50],   // old + fast → deleted
                [now - 3 * DAY, 200, 800],  // old + slow(hub>500) → kept
                [now - 3 * DAY, 500, 40],   // old + error → kept
                [now - 15 * DAY, 200, 900], // past tail window → deleted
                [now, 200, 50]              // fresh → kept
            ]
            for (const [ts, status, totalMs] of samples) {
                recordHubPerfSample(db, {
                    ts, method: 'GET', path: '/api/x', status, totalMs, namespace: 'default'
                })
            }
            tickTelemetry(db, now + 1_000)

            const result = sweepTelemetry(db, now, { force: true })
            expect(result).toEqual({ eventsSwept: true, perfSwept: true })

            const events = db.prepare('SELECT id FROM telemetry_events ORDER BY id').all() as Array<{ id: string }>
            expect(events.map((row) => row.id)).toEqual(['fresh'])

            const kept = (db.prepare('SELECT ts, status, total_ms FROM perf_samples ORDER BY ts').all()) as Array<{
                ts: number
                status: number
                total_ms: number
            }>
            expect(kept).toEqual([
                { ts: now - 3 * DAY, status: 200, total_ms: 800 },
                { ts: now - 3 * DAY, status: 500, total_ms: 40 },
                { ts: now, status: 200, total_ms: 50 }
            ])
        } finally {
            store.close()
        }
    })

    it('trims to the hard row cap by deleting the oldest rows', () => {
        const store = new Store(':memory:')
        try {
            const db = rawDb(store)
            const now = Date.now()
            const cap = 200_000
            db.transaction(() => {
                const insert = db.prepare(`
                    INSERT INTO telemetry_events (
                        id, ts, received_at, namespace, user_id, device_id, device_kind,
                        origin_kind, domain, kind, level, severity, seq, session_id,
                        fingerprint, data_json, hub_version, web_version
                    ) VALUES (?, ?, ?, 'default', '1', 'd', 'browser', 'direct', 'ux', 'session_open', 1, NULL, 0, NULL, NULL, '{}', 't', 't')
                `)
                for (let i = 0; i < cap + 50; i++) {
                    insert.run(`cap-${i}`, now - i, now - i)
                }
            })()
            sweepTelemetry(db, now, { force: true })
            const count = (db.prepare('SELECT COUNT(*) AS n FROM telemetry_events').get() as { n: number }).n
            expect(count).toBe(cap)
            // The 50 oldest rows (received_at now-(cap+49) … now-cap) are gone;
            // the newest row survives untouched.
            const oldest = (db.prepare('SELECT MIN(received_at) AS m FROM telemetry_events').get() as { m: number }).m
            expect(oldest).toBe(now - (cap - 1))
            const newest = (db.prepare('SELECT MAX(received_at) AS m FROM telemetry_events').get() as { m: number }).m
            expect(newest).toBe(now)
        } finally {
            store.close()
        }
    })

    it('honors the raw-window env override', () => {
        process.env.HAPI_PERF_RAW_WINDOW_HOURS = '2'
        try {
            expect(perfRawWindowHours()).toBe(2)
        } finally {
            delete process.env.HAPI_PERF_RAW_WINDOW_HOURS
        }
        expect(perfRawWindowHours()).toBe(48)
    })
})

describe('deploy marks', () => {
    it('records a hub-start mark with the resolved hub version', () => {
        const store = new Store(':memory:')
        try {
            const db = rawDb(store)
            recordDeployMark(db, 'hub-start', resolveHubVersion(), 123)
            const rows = db.prepare('SELECT ts, kind, actor, version FROM perf_deploy_marks').all() as Array<Record<string, unknown>>
            expect(rows).toEqual([{ ts: 123, kind: 'hub-start', actor: null, version: resolveHubVersion() }])
        } finally {
            store.close()
        }
    })
})

describe('tickTelemetry L3 auto-fallback wiring', () => {
    it('invokes the fallback at most once per minute and fail-silently', async () => {
        const store = new Store(':memory:')
        try {
            const db = rawDb(store)
            let calls = 0
            const fallback = async (_dataDir: string, now: number) => {
                calls += 1
                if (calls === 1) throw new Error('settings exploded')
                return now > 0
            }
            const now = Date.now()
            tickTelemetry(db, now, { dataDir: '/tmp/whatever', fallbackL3: fallback })
            tickTelemetry(db, now + 1_000, { dataDir: '/tmp/whatever', fallbackL3: fallback })
            // First call throws (fail-silent, still counted); second tick is
            // inside the 60s throttle window so it must not re-invoke.
            expect(calls).toBe(1)
            tickTelemetry(db, now + 61_000, { dataDir: '/tmp/whatever', fallbackL3: fallback })
            expect(calls).toBe(2)
        } finally {
            store.close()
        }
    })
})
