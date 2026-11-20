import type { Database } from 'bun:sqlite'
import { APP_VERSION } from '@hapi/protocol'
import {
    normalizeApiPath,
    validateTelemetryEvent,
    type TelemetryBatch,
    type TelemetryLevel
} from '@hapi/protocol/telemetry'
import { prepareCached } from './statementCache'

/**
 * Detailed-logging telemetry store (P0; design source: docs/research report
 * 2026-11-20 §5). Two table families behind one ingest writer:
 *
 * - `telemetry_events` — generic ux/diag events (~800 rows/day), read-time
 *   SQL aggregation, idempotent on the client event id (INSERT OR IGNORE).
 * - `perf_samples` / `perf_sse_episodes` / `perf_web_vitals` — narrow
 *   columnar perf rows (~77k rows/day) with day-bucket rollup
 *   (`perf_rollup_daily`, dirty-bucket recompute) and deploy marks.
 *
 * Retention is in-repo day-one (`sweepTelemetry`): raw perf full fidelity for
 * a short window, slow/error tails 14d, hard row caps as a second fence.
 * Everything here is fail-silent towards callers that ride the engine tick:
 * telemetry must never take down hub functionality.
 */

// ---------------------------------------------------------------------------
// DDL (single source for createSchema and the v38→v39 step migration)
// ---------------------------------------------------------------------------

export const TELEMETRY_TABLES_SQL = `
    CREATE TABLE IF NOT EXISTS telemetry_events (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        received_at INTEGER NOT NULL,
        namespace TEXT NOT NULL,
        user_id TEXT,
        device_id TEXT NOT NULL,
        device_kind TEXT NOT NULL,
        origin_kind TEXT,
        domain TEXT NOT NULL CHECK (domain IN ('ux','diag')),
        kind TEXT NOT NULL,
        level INTEGER NOT NULL DEFAULT 1,
        severity TEXT,
        seq INTEGER NOT NULL DEFAULT 0,
        session_id TEXT,
        fingerprint TEXT,
        data_json TEXT,
        hub_version TEXT NOT NULL,
        web_version TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tel_ns_received
        ON telemetry_events(namespace, received_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tel_ns_kind_ts
        ON telemetry_events(namespace, domain, kind, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_tel_ns_fp_ts
        ON telemetry_events(namespace, fingerprint, ts DESC) WHERE fingerprint IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_tel_ns_ses_ts
        ON telemetry_events(namespace, session_id, ts DESC) WHERE session_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS perf_samples (
        id INTEGER PRIMARY KEY,
        ts INTEGER NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('web','hub')),
        trace_id TEXT,
        device_id TEXT,
        origin_kind TEXT,
        method TEXT NOT NULL,
        path_tpl TEXT NOT NULL,
        status INTEGER NOT NULL,
        phase TEXT,
        code TEXT,
        attempt INTEGER,
        trigger TEXT,
        ttfb_ms INTEGER,
        total_ms INTEGER NOT NULL,
        req_bytes INTEGER,
        res_bytes INTEGER,
        res_bytes_source TEXT,
        cache_hit INTEGER,
        session_id TEXT,
        hub_version TEXT NOT NULL,
        web_version TEXT,
        namespace TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_perf_ns_ts ON perf_samples(namespace, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_perf_tpl_ts ON perf_samples(path_tpl, ts);
    CREATE INDEX IF NOT EXISTS idx_perf_trace ON perf_samples(trace_id) WHERE trace_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS perf_sse_episodes (
        id INTEGER PRIMARY KEY,
        ts INTEGER NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('web','hub')),
        subscription_id TEXT,
        scope TEXT,
        resume TEXT,
        connect_ms INTEGER,
        duration_ms INTEGER NOT NULL,
        events_count INTEGER NOT NULL DEFAULT 0,
        bytes_sent INTEGER,
        replay_events INTEGER,
        replay_bytes INTEGER,
        folded_drops INTEGER,
        hidden_markers INTEGER,
        gap_ms INTEGER,
        disconnect_reason TEXT,
        device_id TEXT,
        origin_kind TEXT,
        hub_version TEXT NOT NULL,
        web_version TEXT,
        namespace TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_perf_sse_ts ON perf_sse_episodes(namespace, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_perf_sse_sub
        ON perf_sse_episodes(subscription_id) WHERE subscription_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS perf_web_vitals (
        id INTEGER PRIMARY KEY,
        ts INTEGER NOT NULL,
        page_kind TEXT NOT NULL,
        lcp_ms INTEGER,
        inp_p75_ms INTEGER,
        inp_max_ms INTEGER,
        interactions INTEGER,
        cls REAL,
        long_tasks INTEGER,
        long_task_ms_total INTEGER,
        slowest_json TEXT,
        device_id TEXT,
        origin_kind TEXT,
        hub_version TEXT NOT NULL,
        web_version TEXT,
        namespace TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_perf_vitals_ts ON perf_web_vitals(namespace, ts DESC);

    CREATE TABLE IF NOT EXISTS perf_rollup_daily (
        day TEXT NOT NULL,
        source TEXT NOT NULL,
        path_tpl TEXT NOT NULL,
        method TEXT NOT NULL,
        status_class TEXT NOT NULL,
        version TEXT NOT NULL,
        origin_kind TEXT NOT NULL DEFAULT 'any',
        sample_count INTEGER NOT NULL,
        p50_ms INTEGER NOT NULL,
        p95_ms INTEGER NOT NULL,
        p99_ms INTEGER NOT NULL,
        max_ms INTEGER NOT NULL,
        total_ms_sum INTEGER NOT NULL,
        bytes_sum INTEGER NOT NULL,
        bytes_samples INTEGER NOT NULL,
        PRIMARY KEY (day, source, path_tpl, method, status_class, version, origin_kind)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS perf_deploy_marks (
        id INTEGER PRIMARY KEY,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('hub-start','runner-version','web-version-first-seen')),
        actor TEXT,
        version TEXT NOT NULL
    );
`

// ---------------------------------------------------------------------------
// Constants (queue caps, flush cadence, retention fences)
// ---------------------------------------------------------------------------

const PERF_QUEUE_CAP = 8_192
/** Test-facing alias so queue-cap assertions stay tied to the real constant. */
export const PERF_QUEUE_CAP_FOR_TESTS = PERF_QUEUE_CAP
const PERF_FLUSH_INTERVAL_MS = 30_000
const PERF_FLUSH_MIN_BATCH = 64
const ROLLUP_INTERVAL_MS = 10 * 60_000
const PERF_SWEEP_INTERVAL_MS = 10 * 60_000
const EVENTS_SWEEP_INTERVAL_MS = 60 * 60_000
const L3_CHECK_INTERVAL_MS = 60_000

const EVENTS_MAX_AGE_MS = 14 * 24 * 3_600_000
const EVENTS_ROW_CAP = 200_000
const PERF_TAIL_MAX_AGE_MS = 14 * 24 * 3_600_000
const PERF_ROW_CAP = 1_500_000
const EPISODES_MAX_AGE_MS = 14 * 24 * 3_600_000
const EPISODES_ROW_CAP = 300_000
const VITALS_MAX_AGE_MS = 14 * 24 * 3_600_000
const VITALS_ROW_CAP = 100_000

/** Hub-plane row stays in the slow/error tail when total_ms exceeds this. */
const HUB_SLOW_MS = 500
/** Web-upload row slow tail threshold (browser fetches carry the network leg). */
const WEB_SLOW_MS = 1_500
/** Hard bound on the in-memory dirty-bucket set (path cardinality fence). */
const DIRTY_BUCKET_CAP = 10_000

const DEFAULT_PERF_RAW_WINDOW_HOURS = 48

/** Server-stamped hub build label (deploy pipeline writes HAPI_BUILD_LABEL). */
export function resolveHubVersion(): string {
    return process.env.HAPI_BUILD_LABEL || APP_VERSION
}

/** Raw perf retention window (hours); env HAPI_PERF_RAW_WINDOW_HOURS tunes it. */
export function perfRawWindowHours(): number {
    const raw = Number(process.env.HAPI_PERF_RAW_WINDOW_HOURS)
    if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_PERF_RAW_WINDOW_HOURS
    return Math.min(raw, 24 * 14)
}

// ---------------------------------------------------------------------------
// Per-database runtime state (queue, dirty buckets, sweep throttles)
// ---------------------------------------------------------------------------

/** Input shape handed over by the hub-plane perf middleware. */
export interface HubPerfSampleInput {
    ts: number
    method: string
    /** Raw request path; normalized to path_tpl on record. */
    path: string
    status: number
    totalMs: number
    traceId?: string
    reqBytes?: number
    resBytes?: number
    namespace: string
}

type RollupBucketKey = string // JSON.stringify([day, source, pathTpl, method, statusClass, version, originKind])

/**
 * Recent client event ids for perf rows. telemetry_events dedupes via its
 * PRIMARY KEY, but the perf tables are rowid-per-report DDL — and the web SDK
 * deliberately re-delivers pagehide batches (keepalive POST + the same events
 * sitting in the outbox for the next load). Without this guard every replay
 * would double-count perf samples. Bounded and in-memory only: a replay after
 * a hub restart still double-counts (accepted — statistical noise, and the
 * alternative is a dedup column the report DDL explicitly omits).
 */
const RECENT_PERF_ID_CAP = 65_536

interface TelemetryDbState {
    queue: HubPerfSampleInput[]
    queueDropped: number
    lastFlushAt: number
    dirtyBuckets: Set<RollupBucketKey>
    dirtyDropped: number
    lastRollupAt: number
    lastPerfSweepAt: number
    lastEventsSweepAt: number
    lastL3CheckAt: number
    recentPerfIds: Set<string>
    /**
     * Hub-plane level gate (review finding #1): settings telemetryLevel as
     * of the last refresh, 0 until proven otherwise (privacy-first — the
     * opt-in default records nothing). Refreshed from the engine tick and
     * eagerly by the PUT /hub-settings telemetryLevel route; see
     * refreshHubTelemetryLevel for the staleness window.
     */
    cachedLevel: number
}

const states = new WeakMap<Database, TelemetryDbState>()

function stateFor(db: Database): TelemetryDbState {
    let state = states.get(db)
    if (!state) {
        state = {
            queue: [],
            queueDropped: 0,
            lastFlushAt: 0,
            dirtyBuckets: new Set(),
            dirtyDropped: 0,
            lastRollupAt: 0,
            lastPerfSweepAt: 0,
            lastEventsSweepAt: 0,
            lastL3CheckAt: 0,
            recentPerfIds: new Set(),
            cachedLevel: 0
        }
        states.set(db, state)
    }
    return state
}

// ---------------------------------------------------------------------------
// Bucket helpers
// ---------------------------------------------------------------------------

function utcDay(ts: number): string {
    return new Date(ts).toISOString().slice(0, 10)
}

function dayStartTs(day: string): number {
    return Date.parse(`${day}T00:00:00.000Z`)
}

function statusClass(status: number): string {
    return status === 0 ? '0' : `${Math.floor(status / 100)}xx`
}

function statusClassInt(statusClassStr: string): number {
    return statusClassStr === '0' ? 0 : Number(statusClassStr.slice(0, 1))
}

function rollupVersion(source: 'web' | 'hub', webVersion: string | null | undefined, hubVersion: string): string {
    return source === 'web' ? (webVersion ?? 'unknown') : hubVersion
}

function bucketKey(
    day: string,
    source: 'web' | 'hub',
    pathTpl: string,
    method: string,
    statusClassStr: string,
    version: string,
    originKind: string
): RollupBucketKey {
    return JSON.stringify([day, source, pathTpl, method, statusClassStr, version, originKind])
}

function markBucketDirty(db: Database, key: RollupBucketKey): void {
    const state = stateFor(db)
    if (state.dirtyBuckets.has(key)) return
    if (state.dirtyBuckets.size >= DIRTY_BUCKET_CAP) {
        state.dirtyDropped++
        return
    }
    state.dirtyBuckets.add(key)
}

/** Nearest-rank percentile over an ascending-sorted list (1-indexed rank). */
export function nearestRankPercentile(sortedAsc: number[], percentile: number): number {
    if (sortedAsc.length === 0) return 0
    const rank = Math.max(1, Math.ceil((percentile / 100) * sortedAsc.length))
    return sortedAsc[Math.min(rank, sortedAsc.length) - 1]!
}

// ---------------------------------------------------------------------------
// Ingest: POST /api/telemetry/events → single transaction, split by domain
// ---------------------------------------------------------------------------

export interface TelemetryIngestOptions {
    namespace: string
    /** JWT uid, stamped server-side (never trusted from the client). */
    userId: number
    /** Effective telemetry level; events whose spec.minLevel exceeds it drop. */
    level: TelemetryLevel
    now?: number
}

export interface TelemetryIngestResult {
    accepted: number
    rejected: number
    droppedByLevel: number
}

export function insertTelemetryBatch(
    db: Database,
    options: TelemetryIngestOptions,
    batch: TelemetryBatch
): TelemetryIngestResult {
    const now = options.now ?? Date.now()
    const hubVersion = resolveHubVersion()
    const result: TelemetryIngestResult = { accepted: 0, rejected: 0, droppedByLevel: 0 }

    interface EventRow {
        id: string
        ts: number
        receivedAt: number
        domain: string
        kind: string
        level: number
        severity: string | null
        seq: number
        sessionId: string | null
        fingerprint: string | null
        dataJson: string
    }
    interface SampleRow {
        ts: number
        source: 'web'
        traceId: string | null
        deviceId: string
        originKind: string | null
        method: string
        pathTpl: string
        status: number
        phase: string | null
        code: string | null
        attempt: number | null
        trigger: string | null
        ttfbMs: number | null
        totalMs: number
        reqBytes: number | null
        resBytes: number | null
        resBytesSource: string | null
        cacheHit: number | null
        sessionId: string | null
    }
    interface EpisodeRow {
        ts: number
        subscriptionId: string | null
        scope: string | null
        resume: string | null
        connectMs: number | null
        durationMs: number
        eventsCount: number
        bytesSent: number | null
        gapMs: number | null
        disconnectReason: string | null
        deviceId: string
        originKind: string | null
    }
    interface VitalRow {
        ts: number
        lcpMs: number | null
        inpP75Ms: number | null
        inpMaxMs: number | null
        interactions: number | null
        cls: number | null
        longTasks: number | null
        longTaskMsTotal: number | null
        slowestJson: string | null
        deviceId: string
        originKind: string | null
    }

    const eventRows: EventRow[] = []
    const sampleRows: SampleRow[] = []
    const episodeRows: EpisodeRow[] = []
    const vitalRows: VitalRow[] = []
    const num = (v: unknown): number | null =>
        (typeof v === 'number' && Number.isFinite(v)) ? v : null
    const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
    // Perf rows have no PK on the client id, so replay dedup happens against
    // the in-memory recent-id set. Ids are only recorded AFTER the insert
    // transaction commits — a failed transaction must not poison the set.
    const batchPerfIds = new Set<string>()

    for (const event of batch.events) {
        try {
            const validated = validateTelemetryEvent(event)
            if (!validated.ok) {
                result.rejected++
                continue
            }
            const spec = validated.spec
            if (spec.minLevel > options.level) {
                result.droppedByLevel++
                continue
            }
            const data = validated.data
            if (spec.domain === 'ux' || spec.domain === 'diag') {
                eventRows.push({
                    id: event.id,
                    ts: event.ts,
                    receivedAt: now,
                    domain: spec.domain,
                    kind: event.kind,
                    level: event.level,
                    severity: event.severity ?? null,
                    seq: event.seq,
                    sessionId: event.sessionId ?? null,
                    fingerprint: event.fingerprint ?? null,
                    dataJson: JSON.stringify(data)
                })
            } else if (isRecentPerfEventId(db, event.id) || batchPerfIds.has(event.id)) {
                // Deliberate pagehide re-delivery (keepalive + outbox both fire):
                // the first copy already landed — count processed, insert nothing.
                result.accepted++
                continue
            } else if (event.kind === 'http') {
                batchPerfIds.add(event.id)
                const originKind = str(data.originKind) ?? batch.device.origin
                sampleRows.push({
                    ts: event.ts,
                    source: 'web',
                    traceId: str(data.traceId),
                    deviceId: batch.device.id,
                    originKind,
                    method: String(data.method ?? 'GET'),
                    pathTpl: String(data.pathTpl ?? ''),
                    status: num(data.status) ?? 0,
                    phase: str(data.phase),
                    code: str(data.code),
                    attempt: num(data.attempt),
                    trigger: str(data.trigger),
                    ttfbMs: num(data.ttfbMs),
                    totalMs: num(data.totalMs) ?? 0,
                    reqBytes: num(data.reqBytes),
                    resBytes: num(data.resBytes),
                    resBytesSource: str(data.resBytesSource),
                    cacheHit: typeof data.cacheHit === 'boolean' ? (data.cacheHit ? 1 : 0) : null,
                    sessionId: event.sessionId ?? null
                })
            } else if (event.kind === 'sse_episode') {
                batchPerfIds.add(event.id)
                episodeRows.push({
                    ts: event.ts,
                    subscriptionId: str(data.subscriptionId),
                    scope: str(data.scope),
                    resume: str(data.resume),
                    connectMs: num(data.connectMs),
                    durationMs: num(data.durationMs) ?? 0,
                    eventsCount: num(data.eventsCount) ?? 0,
                    bytesSent: num(data.bytesSent),
                    gapMs: num(data.gapMs),
                    disconnectReason: str(data.disconnectReason),
                    deviceId: batch.device.id,
                    originKind: batch.device.origin
                })
            } else if (event.kind === 'web_vital') {
                batchPerfIds.add(event.id)
                // page_kind is NOT NULL in the DDL but the P0 web SDK does not
                // emit a page split yet — stamp a constant until it lands.
                vitalRows.push({
                    ts: event.ts,
                    lcpMs: num(data.lcpMs),
                    inpP75Ms: num(data.inpP75Ms),
                    inpMaxMs: num(data.inpMaxMs),
                    interactions: num(data.interactions),
                    cls: num(data.cls),
                    longTasks: num(data.longTasks),
                    longTaskMsTotal: num(data.longTaskMsTotal),
                    slowestJson: str(data.slowestJson),
                    deviceId: batch.device.id,
                    originKind: batch.device.origin
                })
            } else {
                // Registered perf kind without a table mapping — count, never throw.
                result.rejected++
                continue
            }
            result.accepted++
        } catch {
            result.rejected++
        }
    }

    if (eventRows.length === 0 && sampleRows.length === 0 && episodeRows.length === 0 && vitalRows.length === 0) {
        return result
    }

    db.transaction(() => {        for (const row of eventRows) {
            prepareCached(db, `
                INSERT OR IGNORE INTO telemetry_events (
                    id, ts, received_at, namespace, user_id, device_id, device_kind,
                    origin_kind, domain, kind, level, severity, seq, session_id,
                    fingerprint, data_json, hub_version, web_version
                ) VALUES (
                    @id, @ts, @received_at, @namespace, @user_id, @device_id, @device_kind,
                    @origin_kind, @domain, @kind, @level, @severity, @seq, @session_id,
                    @fingerprint, @data_json, @hub_version, @web_version
                )
            `).run({
                id: row.id,
                ts: row.ts,
                received_at: row.receivedAt,
                namespace: options.namespace,
                user_id: String(options.userId),
                device_id: batch.device.id,
                device_kind: batch.device.kind,
                origin_kind: batch.device.origin,
                domain: row.domain,
                kind: row.kind,
                level: row.level,
                severity: row.severity,
                seq: row.seq,
                session_id: row.sessionId,
                fingerprint: row.fingerprint,
                data_json: row.dataJson,
                hub_version: hubVersion,
                web_version: batch.appVersion
            })
        }
        for (const row of sampleRows) {
            // Defense-in-depth (review finding #2): a row that somehow slips
            // past the schema ts range check must not throw inside this
            // transaction — that would roll back and 500 the whole batch.
            // The schema guard makes this unreachable; if it ever fires the
            // row degrades to the rejected count instead.
            try {
                prepareCached(db, `
                    INSERT INTO perf_samples (
                        ts, source, trace_id, device_id, origin_kind, method, path_tpl,
                        status, phase, code, attempt, trigger, ttfb_ms, total_ms,
                        req_bytes, res_bytes, res_bytes_source, cache_hit, session_id,
                        hub_version, web_version, namespace
                    ) VALUES (
                        @ts, @source, @trace_id, @device_id, @origin_kind, @method, @path_tpl,
                        @status, @phase, @code, @attempt, @trigger, @ttfb_ms, @total_ms,
                        @req_bytes, @res_bytes, @res_bytes_source, @cache_hit, @session_id,
                        @hub_version, @web_version, @namespace
                    )
                `).run({
                    ts: row.ts,
                    source: row.source,
                    trace_id: row.traceId,
                    device_id: row.deviceId,
                    origin_kind: row.originKind,
                    method: row.method,
                    path_tpl: row.pathTpl,
                    status: row.status,
                    phase: row.phase,
                    code: row.code,
                    attempt: row.attempt,
                    trigger: row.trigger,
                    ttfb_ms: row.ttfbMs,
                    total_ms: row.totalMs,
                    req_bytes: row.reqBytes,
                    res_bytes: row.resBytes,
                    res_bytes_source: row.resBytesSource,
                    cache_hit: row.cacheHit,
                    session_id: row.sessionId,
                    hub_version: hubVersion,
                    web_version: batch.appVersion,
                    namespace: options.namespace
                })
                markBucketDirty(
                    db,
                    bucketKey(
                        utcDay(row.ts),
                        'web',
                        row.pathTpl,
                        row.method,
                        statusClass(row.status),
                        rollupVersion('web', batch.appVersion, hubVersion),
                        row.originKind ?? 'any'
                    )
                )
            } catch {
                result.accepted--
                result.rejected++
            }
        }
        for (const row of episodeRows) {
            prepareCached(db, `
                INSERT INTO perf_sse_episodes (
                    ts, source, subscription_id, scope, resume, connect_ms,
                    duration_ms, events_count, bytes_sent, replay_events, replay_bytes,
                    folded_drops, hidden_markers, gap_ms, disconnect_reason,
                    device_id, origin_kind, hub_version, web_version, namespace
                ) VALUES (
                    @ts, @source, @subscription_id, @scope, @resume, @connect_ms,
                    @duration_ms, @events_count, @bytes_sent, NULL, NULL,
                    NULL, NULL, @gap_ms, @disconnect_reason,
                    @device_id, @origin_kind, @hub_version, @web_version, @namespace
                )
            `).run({
                ts: row.ts,
                source: 'web',
                subscription_id: row.subscriptionId,
                scope: row.scope,
                resume: row.resume,
                connect_ms: row.connectMs,
                duration_ms: row.durationMs,
                events_count: row.eventsCount,
                bytes_sent: row.bytesSent,
                gap_ms: row.gapMs,
                disconnect_reason: row.disconnectReason,
                device_id: row.deviceId,
                origin_kind: row.originKind,
                hub_version: hubVersion,
                web_version: batch.appVersion,
                namespace: options.namespace
            })
        }
        for (const row of vitalRows) {
            prepareCached(db, `
                INSERT INTO perf_web_vitals (
                    ts, page_kind, lcp_ms, inp_p75_ms, inp_max_ms, interactions,
                    cls, long_tasks, long_task_ms_total, slowest_json,
                    device_id, origin_kind, hub_version, web_version, namespace
                ) VALUES (
                    @ts, 'app', @lcp_ms, @inp_p75_ms, @inp_max_ms, @interactions,
                    @cls, @long_tasks, @long_task_ms_total, @slowest_json,
                    @device_id, @origin_kind, @hub_version, @web_version, @namespace
                )
            `).run({
                ts: row.ts,
                lcp_ms: row.lcpMs,
                inp_p75_ms: row.inpP75Ms,
                inp_max_ms: row.inpMaxMs,
                interactions: row.interactions,
                cls: row.cls,
                long_tasks: row.longTasks,
                long_task_ms_total: row.longTaskMsTotal,
                slowest_json: row.slowestJson,
                device_id: row.deviceId,
                origin_kind: row.originKind,
                hub_version: hubVersion,
                web_version: batch.appVersion,
                namespace: options.namespace
            })
        }
    })()

    // Committed: only now are the perf ids eligible for replay dedup.
    recordRecentPerfEventIds(db, batchPerfIds)

    return result
}

/** Read-only recent-id check (see TelemetryDbState.recentPerfIds). */
function isRecentPerfEventId(db: Database, id: string): boolean {
    return states.get(db)?.recentPerfIds.has(id) ?? false
}

/** Record freshly committed perf ids; evict the oldest quarter at the cap. */
function recordRecentPerfEventIds(db: Database, ids: Set<string>): void {
    if (ids.size === 0) return
    const state = stateFor(db)
    if (state.recentPerfIds.size + ids.size > RECENT_PERF_ID_CAP) {
        const drop = Math.max(1, Math.floor(RECENT_PERF_ID_CAP / 4))
        let dropped = 0
        for (const key of state.recentPerfIds) {
            if (dropped++ >= drop) break
            state.recentPerfIds.delete(key)
        }
    }
    for (const id of ids) state.recentPerfIds.add(id)
}

// ---------------------------------------------------------------------------
// Hub-plane middleware queue (bounded, drop-oldest) + flusher
// ---------------------------------------------------------------------------

/**
 * Refresh the hub-plane level gate from settings (review finding #1).
 *
 * Cheap by design: readTelemetryLevelState rides the write-through settings
 * read cache (readSettingsOrThrowCached), so a level just written by this
 * process is a memory hit and external settings.json edits converge within
 * that cache's 5s TTL. Staleness window summary:
 * - PUT /hub-settings telemetryLevel → immediate (the route awaits this
 *   after writeTelemetryLevel; the write-through cache makes it synchronous).
 * - External settings.json edits / other processes → next engine tick (5s)
 *   sees them via the shared TTL cache.
 * - Any read failure → level 0 (off): a hub that cannot prove telemetry is
 *   opted in must not record (privacy-first, same degradation as ingest).
 * - Cold start → 0 until the first engine tick (~5s after boot); the boot
 *   deploy mark is unaffected (recorded once, outside this gate).
 */
export async function refreshHubTelemetryLevel(db: Database, dataDir: string): Promise<void> {
    const state = stateFor(db)
    try {
        const { readTelemetryLevelState } = await import('../config/telemetryLevel')
        state.cachedLevel = (await readTelemetryLevelState(dataDir)).level
    } catch {
        state.cachedLevel = 0
    }
}

/** Middleware entry point: enqueue one hub-plane sample (never throws). */
export function recordHubPerfSample(db: Database, sample: HubPerfSampleInput): void {
    const state = stateFor(db)
    // Level 0 = telemetry opted out: the sample never even enters the
    // in-memory queue (opt-in contract, review finding #1). The trace-header
    // echo stays unconditional — it lives in the middleware, not here.
    if (state.cachedLevel === 0) return
    if (state.queue.length >= PERF_QUEUE_CAP) {
        // Drop-oldest: fresh tail matters more than the head of the window.
        state.queue.shift()
        state.queueDropped++
    }
    state.queue.push(sample)
}

export interface HubPerfQueueStats {
    queued: number
    dropped: number
}

export function hubPerfQueueStats(db: Database): HubPerfQueueStats {
    const state = states.get(db)
    return { queued: state?.queue.length ?? 0, dropped: state?.queueDropped ?? 0 }
}

/** Flush the queue when it is full enough or old enough (single transaction). */
function flushHubPerfQueue(db: Database, now: number): void {
    const state = stateFor(db)
    if (state.queue.length === 0) return
    // Second gate (review finding #1): nothing may be written to perf_samples
    // while telemetry is off. Samples queued under an earlier level >= 1 stay
    // queued (bounded, drop-oldest) and flush if the level comes back.
    if (state.cachedLevel === 0) return
    if (state.queue.length < PERF_FLUSH_MIN_BATCH && now - state.lastFlushAt < PERF_FLUSH_INTERVAL_MS) {
        return
    }
    const batch = state.queue.splice(0, state.queue.length)
    state.lastFlushAt = now
    const hubVersion = resolveHubVersion()
    const statement = prepareCached(db, `
        INSERT INTO perf_samples (
            ts, source, trace_id, device_id, origin_kind, method, path_tpl,
            status, phase, code, attempt, trigger, ttfb_ms, total_ms,
            req_bytes, res_bytes, res_bytes_source, cache_hit, session_id,
            hub_version, web_version, namespace
        ) VALUES (
            @ts, 'hub', @trace_id, NULL, NULL, @method, @path_tpl,
            @status, NULL, NULL, NULL, NULL, NULL, @total_ms,
            @req_bytes, @res_bytes, NULL, NULL, NULL,
            @hub_version, NULL, @namespace
        )
    `)
    db.transaction(() => {
        for (const sample of batch) {
            const pathTpl = normalizeApiPath(sample.method, sample.path)
            statement.run({
                ts: sample.ts,
                trace_id: sample.traceId ?? null,
                method: sample.method,
                path_tpl: pathTpl,
                status: sample.status,
                total_ms: Math.max(0, Math.round(sample.totalMs)),
                req_bytes: sample.reqBytes ?? null,
                res_bytes: sample.resBytes ?? null,
                namespace: sample.namespace,
                hub_version: hubVersion
            })
            markBucketDirty(
                db,
                bucketKey(
                    utcDay(sample.ts),
                    'hub',
                    pathTpl,
                    sample.method,
                    statusClass(sample.status),
                    hubVersion,
                    'any'
                )
            )
        }
    })()
}

// ---------------------------------------------------------------------------
// Rollup: dirty-bucket recompute (nearest-rank percentiles in JS)
// ---------------------------------------------------------------------------

function rollupDueBuckets(db: Database, now: number): void {
    const state = stateFor(db)
    if (state.dirtyBuckets.size === 0) return
    if (now - state.lastRollupAt < ROLLUP_INTERVAL_MS) return
    state.lastRollupAt = now
    const keys = Array.from(state.dirtyBuckets)
    state.dirtyBuckets.clear()
    const hubVersion = resolveHubVersion()
    for (const key of keys) {
        try {
            const [day, source, pathTpl, method, statusClassStr, version, originKind] =
                JSON.parse(key) as [string, 'web' | 'hub', string, string, string, string, string]
            const startTs = dayStartTs(day)
            const endTs = startTs + 86_400_000
            const versionColumn = source === 'web' ? "COALESCE(web_version, 'unknown')" : 'hub_version'
            const rows = prepareCached(db, `
                SELECT total_ms, res_bytes FROM perf_samples
                WHERE ts >= ? AND ts < ? AND source = ? AND path_tpl = ? AND method = ?
                  AND (CASE WHEN status = 0 THEN 0 ELSE status / 100 END) = ?
                  AND COALESCE(origin_kind, 'any') = ?
                  AND ${versionColumn} = ?
            `).all(startTs, endTs, source, pathTpl, method, statusClassInt(statusClassStr), originKind, version) as Array<{
                total_ms: number
                res_bytes: number | null
            }>
            if (rows.length === 0) continue
            const totals = rows.map((row) => row.total_ms).sort((a, b) => a - b)
            let bytesSum = 0
            let bytesSamples = 0
            for (const row of rows) {
                if (row.res_bytes !== null) {
                    bytesSum += row.res_bytes
                    bytesSamples++
                }
            }
            prepareCached(db, `
                REPLACE INTO perf_rollup_daily (
                    day, source, path_tpl, method, status_class, version, origin_kind,
                    sample_count, p50_ms, p95_ms, p99_ms, max_ms,
                    total_ms_sum, bytes_sum, bytes_samples
                ) VALUES (
                    @day, @source, @path_tpl, @method, @status_class, @version, @origin_kind,
                    @sample_count, @p50_ms, @p95_ms, @p99_ms, @max_ms,
                    @total_ms_sum, @bytes_sum, @bytes_samples
                )
            `).run({
                day,
                source,
                path_tpl: pathTpl,
                method,
                status_class: statusClassStr,
                version,
                origin_kind: originKind,
                sample_count: totals.length,
                p50_ms: nearestRankPercentile(totals, 50),
                p95_ms: nearestRankPercentile(totals, 95),
                p99_ms: nearestRankPercentile(totals, 99),
                max_ms: totals[totals.length - 1]!,
                total_ms_sum: totals.reduce((sum, value) => sum + value, 0),
                bytes_sum: bytesSum,
                bytes_samples: bytesSamples
            })
        } catch {
            // One bad bucket must not abort the rest of the rollup pass.
        }
    }
}

/**
 * Seed today's buckets as dirty after a restart so the rollup pass recompute
 * never misses buckets whose rows survived while the process was down.
 */
export function seedTodayDirtyBuckets(db: Database, now: number = Date.now()): void {
    const day = utcDay(now)
    const startTs = dayStartTs(day)
    const rows = prepareCached(db, `
        SELECT source, path_tpl, method,
               CASE WHEN status = 0 THEN 0 ELSE status / 100 END AS status_class_int,
               COALESCE(origin_kind, 'any') AS origin_kind,
               CASE WHEN source = 'web' THEN COALESCE(web_version, 'unknown') ELSE hub_version END AS version
        FROM perf_samples WHERE ts >= ?
        GROUP BY source, path_tpl, method, status_class_int, origin_kind, version
    `).all(startTs) as Array<{
        source: 'web' | 'hub'
        path_tpl: string
        method: string
        status_class_int: number
        origin_kind: string
        version: string
    }>
    for (const row of rows) {
        markBucketDirty(
            db,
            bucketKey(
                day,
                row.source,
                row.path_tpl,
                row.method,
                row.status_class_int === 0 ? '0' : `${row.status_class_int}xx`,
                row.version,
                row.origin_kind
            )
        )
    }
}

// ---------------------------------------------------------------------------
// Retention sweep (day-one, in-repo; never depends on external trim SOPs)
// ---------------------------------------------------------------------------

export interface TelemetrySweepResult {
    eventsSwept: boolean
    perfSwept: boolean
}

function isPerfTailRow(source: string, totalMs: number, status: number): boolean {
    if (status >= 400) return true
    return source === 'web' ? totalMs > WEB_SLOW_MS : totalMs > HUB_SLOW_MS
}

function deleteBeyondRowCap(db: Database, table: string, orderBy: string, cap: number): void {
    const count = (prepareCached(db, `SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
    if (count <= cap) return
    // Keep the newest `cap` rows (ORDER DESC), delete everything older.
    prepareCached(db, `
        DELETE FROM ${table} WHERE id IN (
            SELECT id FROM ${table} ORDER BY ${orderBy} DESC, id DESC LIMIT -1 OFFSET ${cap}
        )
    `).run()
}

export function sweepTelemetry(
    db: Database,
    now: number,
    options?: { force?: boolean }
): TelemetrySweepResult {
    const state = stateFor(db)
    const perfDue = options?.force === true || now - state.lastPerfSweepAt >= PERF_SWEEP_INTERVAL_MS
    const eventsDue = options?.force === true || now - state.lastEventsSweepAt >= EVENTS_SWEEP_INTERVAL_MS
    const result: TelemetrySweepResult = { eventsSwept: false, perfSwept: false }

    if (perfDue) {
        state.lastPerfSweepAt = now
        result.perfSwept = true
        const rawWindowMs = perfRawWindowHours() * 3_600_000
        const rawCutoff = now - rawWindowMs
        const tailCutoff = now - PERF_TAIL_MAX_AGE_MS
        // Keep slow/error tails past the raw window; everything past the 14d
        // tail window goes unconditionally.
        prepareCached(db, `
            DELETE FROM perf_samples
            WHERE ts < ? OR (
                ts < ?
                AND NOT (
                    (source = 'hub' AND (total_ms > ${HUB_SLOW_MS} OR status >= 400))
                    OR (source = 'web' AND (total_ms > ${WEB_SLOW_MS} OR status >= 400))
                )
            )
        `).run(tailCutoff, rawCutoff)
        deleteBeyondRowCap(db, 'perf_samples', 'id', PERF_ROW_CAP)
        prepareCached(db, 'DELETE FROM perf_sse_episodes WHERE ts < ?').run(now - EPISODES_MAX_AGE_MS)
        deleteBeyondRowCap(db, 'perf_sse_episodes', 'id', EPISODES_ROW_CAP)
        prepareCached(db, 'DELETE FROM perf_web_vitals WHERE ts < ?').run(now - VITALS_MAX_AGE_MS)
        deleteBeyondRowCap(db, 'perf_web_vitals', 'id', VITALS_ROW_CAP)
    }

    if (eventsDue) {
        state.lastEventsSweepAt = now
        result.eventsSwept = true
        prepareCached(db, 'DELETE FROM telemetry_events WHERE received_at < ?').run(now - EVENTS_MAX_AGE_MS)
        deleteBeyondRowCap(db, 'telemetry_events', 'received_at', EVENTS_ROW_CAP)
    }

    return result
}

// ---------------------------------------------------------------------------
// Engine tick: one entry point riding the 5s syncEngine inactivity tick
// ---------------------------------------------------------------------------

export interface TelemetryTickOptions {
    /** Settings root for the L3 auto-fallback check; null skips it. */
    dataDir?: string | null
    /** Injected to avoid an import cycle config ⇄ store in tests. */
    fallbackL3?: (dataDir: string, now: number) => Promise<boolean>
    /** Injected level reader for the hub-plane gate (same cycle avoidance). */
    readTelemetryLevel?: (dataDir: string) => Promise<TelemetryLevel>
}

async function defaultReadTelemetryLevel(dataDir: string): Promise<TelemetryLevel> {
    const { readTelemetryLevelState } = await import('../config/telemetryLevel')
    return (await readTelemetryLevelState(dataDir)).level
}

export function tickTelemetry(db: Database, now: number, options?: TelemetryTickOptions): void {
    try {
        flushHubPerfQueue(db, now)
    } catch { }
    try {
        rollupDueBuckets(db, now)
    } catch { }
    try {
        sweepTelemetry(db, now)
    } catch { }
    const dataDir = options?.dataDir
    if (!dataDir) return
    const state = stateFor(db)
    // Hub-plane level gate refresh rides the same 5s tick (review finding
    // #1): fire-and-forget, cheap (write-through settings read cache) and
    // fail-silent — a failed refresh keeps the last value.
    const readLevel = options?.readTelemetryLevel ?? defaultReadTelemetryLevel
    try {
        void readLevel(dataDir).then(
            (level) => { state.cachedLevel = level },
            () => undefined
        )
    } catch { }
    if (now - state.lastL3CheckAt < L3_CHECK_INTERVAL_MS) return
    state.lastL3CheckAt = now
    const fallback = options?.fallbackL3 ?? defaultL3Fallback
    try {
        void fallback(dataDir, now).catch(() => undefined)
    } catch { }
}

async function defaultL3Fallback(dataDir: string, now: number): Promise<boolean> {
    const { maybeFallbackTelemetryLevel } = await import('../config/telemetryLevel')
    return maybeFallbackTelemetryLevel(dataDir, now)
}

// ---------------------------------------------------------------------------
// Deploy marks + query helpers for the read endpoints
// ---------------------------------------------------------------------------

export function recordDeployMark(
    db: Database,
    kind: 'hub-start' | 'runner-version' | 'web-version-first-seen',
    version: string,
    now: number = Date.now(),
    actor?: string
): void {
    prepareCached(db, 'INSERT INTO perf_deploy_marks (ts, kind, actor, version) VALUES (?, ?, ?, ?)')
        .run(now, kind, actor ?? null, version)
}

export interface TelemetryEventSummaryOptions {
    namespace: string
    domain: 'ux' | 'diag'
    group: 'session' | 'kind' | 'fingerprint'
    since?: number
    until?: number
    limit: number
}

export interface TelemetryEventSummaryRow {
    key: string
    count: number
    errorCount: number
    firstTs: number
    lastTs: number
}

export function telemetryEventSummary(
    db: Database,
    options: TelemetryEventSummaryOptions
): TelemetryEventSummaryRow[] {
    const column = options.group === 'session'
        ? 'session_id'
        : options.group === 'fingerprint'
            ? 'fingerprint'
            : 'kind'
    const rows = prepareCached(db, `
        SELECT ${column} AS key, COUNT(*) AS count,
               SUM(CASE WHEN severity = 'error' THEN 1 ELSE 0 END) AS error_count,
               MIN(ts) AS first_ts, MAX(ts) AS last_ts
        FROM telemetry_events
        WHERE namespace = ? AND domain = ? AND ${column} IS NOT NULL
          AND ts >= ? AND ts <= ?
        GROUP BY ${column}
        ORDER BY count DESC, key ASC
        LIMIT ?
    `).all(
        options.namespace,
        options.domain,
        options.since ?? 0,
        options.until ?? Number.MAX_SAFE_INTEGER,
        options.limit
    ) as Array<{ key: string; count: number; error_count: number; first_ts: number; last_ts: number }>
    return rows.map((row) => ({
        key: row.key,
        count: row.count,
        errorCount: row.error_count ?? 0,
        firstTs: row.first_ts,
        lastTs: row.last_ts
    }))
}

export interface PerfRollupSummaryOptions {
    sinceDay: string
    source?: 'web' | 'hub'
}

export interface PerfRollupSummaryRow {
    source: string
    method: string
    pathTpl: string
    sampleCount: number
    p50Ms: number
    p95Ms: number
    p99Ms: number
    maxMs: number
    avgMs: number
}

/** Cross-bucket P50/P95/P99 are count-weighted approximations (approx flag upstream). */
export function perfRollupSummary(db: Database, options: PerfRollupSummaryOptions): PerfRollupSummaryRow[] {
    const rows = prepareCached(db, `
        SELECT source, method, path_tpl,
               SUM(sample_count) AS sample_count,
               MAX(max_ms) AS max_ms,
               CAST(ROUND(SUM(CAST(p50_ms AS REAL) * sample_count) / SUM(sample_count)) AS INTEGER) AS p50_ms,
               CAST(ROUND(SUM(CAST(p95_ms AS REAL) * sample_count) / SUM(sample_count)) AS INTEGER) AS p95_ms,
               CAST(ROUND(SUM(CAST(p99_ms AS REAL) * sample_count) / SUM(sample_count)) AS INTEGER) AS p99_ms,
               CAST(SUM(total_ms_sum) / SUM(sample_count) AS INTEGER) AS avg_ms
        FROM perf_rollup_daily
        WHERE day >= ? ${options.source ? 'AND source = ?' : ''}
        GROUP BY source, method, path_tpl
        ORDER BY sample_count DESC
        LIMIT 500
    `).all(
        ...(options.source ? [options.sinceDay, options.source] : [options.sinceDay])
    ) as Array<{
        source: string
        method: string
        path_tpl: string
        sample_count: number
        p50_ms: number
        p95_ms: number
        p99_ms: number
        max_ms: number
        avg_ms: number
    }>
    return rows.map((row) => ({
        source: row.source,
        method: row.method,
        pathTpl: row.path_tpl,
        sampleCount: row.sample_count,
        p50Ms: row.p50_ms,
        p95Ms: row.p95_ms,
        p99Ms: row.p99_ms,
        maxMs: row.max_ms,
        avgMs: row.avg_ms
    }))
}

export interface PerfSlowSampleRow {
    ts: number
    source: string
    method: string
    pathTpl: string
    status: number
    ttfbMs: number | null
    totalMs: number
    reqBytes: number | null
    resBytes: number | null
    sessionId: string | null
    traceId: string | null
    namespace: string
}

export function listSlowPerfSamples(
    db: Database,
    options: { sinceTs: number; source?: 'web' | 'hub'; limit: number }
): PerfSlowSampleRow[] {
    const sourceFilter = options.source ? 'AND source = ?' : ''
    const rows = prepareCached(db, `
        SELECT ts, source, method, path_tpl, status, ttfb_ms, total_ms,
               req_bytes, res_bytes, session_id, trace_id, namespace
        FROM perf_samples
        WHERE ts >= ? ${sourceFilter}
        ORDER BY total_ms DESC
        LIMIT ?
    `).all(
        ...(options.source ? [options.sinceTs, options.source, options.limit] : [options.sinceTs, options.limit])
    ) as Array<{
        ts: number
        source: string
        method: string
        path_tpl: string
        status: number
        ttfb_ms: number | null
        total_ms: number
        req_bytes: number | null
        res_bytes: number | null
        session_id: string | null
        trace_id: string | null
        namespace: string
    }>
    return rows.map((row) => ({
        ts: row.ts,
        source: row.source,
        method: row.method,
        pathTpl: row.path_tpl,
        status: row.status,
        ttfbMs: row.ttfb_ms,
        totalMs: row.total_ms,
        reqBytes: row.req_bytes,
        resBytes: row.res_bytes,
        sessionId: row.session_id,
        traceId: row.trace_id,
        namespace: row.namespace
    }))
}

// ---------------------------------------------------------------------------
// Store facade (mirrors UsageStore / WorkGraphStore wiring)
// ---------------------------------------------------------------------------

export class TelemetryStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
        try {
            // Post-restart buckets: rows that arrived before this process
            // started must still get their rollup pass.
            seedTodayDirtyBuckets(db)
        } catch {
            // Fresh/odd databases must never fail Store construction.
        }
    }

    insertBatch(options: TelemetryIngestOptions, batch: TelemetryBatch): TelemetryIngestResult {
        return insertTelemetryBatch(this.db, options, batch)
    }

    recordHubSample(sample: HubPerfSampleInput): void {
        recordHubPerfSample(this.db, sample)
    }

    /** Awaited level-gate refresh; the PUT /hub-settings telemetryLevel route
     * calls this so the hub plane flips immediately after a write. */
    async refreshLevel(dataDir: string): Promise<void> {
        await refreshHubTelemetryLevel(this.db, dataDir)
    }

    hubQueueStats(): HubPerfQueueStats {
        return hubPerfQueueStats(this.db)
    }

    tick(now: number, options?: TelemetryTickOptions): void {
        tickTelemetry(this.db, now, options)
    }

    sweep(now: number, options?: { force?: boolean }): TelemetrySweepResult {
        return sweepTelemetry(this.db, now, options)
    }

    recordDeployMark(
        kind: 'hub-start' | 'runner-version' | 'web-version-first-seen',
        version: string,
        now?: number,
        actor?: string
    ): void {
        recordDeployMark(this.db, kind, version, now, actor)
    }

    eventSummary(options: TelemetryEventSummaryOptions): TelemetryEventSummaryRow[] {
        return telemetryEventSummary(this.db, options)
    }

    rollupSummary(options: PerfRollupSummaryOptions): PerfRollupSummaryRow[] {
        return perfRollupSummary(this.db, options)
    }

    slowSamples(options: { sinceTs: number; source?: 'web' | 'hub'; limit: number }): PerfSlowSampleRow[] {
        return listSlowPerfSamples(this.db, options)
    }
}
