import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import {
    TELEMETRY_BODY_LIMIT_BYTES,
    TelemetryBatchSchema,
    type TelemetryLevel
} from '@hapi/protocol/telemetry'
import { readTelemetryLevelState } from '../../config/telemetryLevel'
import { perfRawWindowHours, type Store } from '../../store'
import type { WebAppEnv } from '../middleware/auth'

const OWNER_ONLY_ERROR = 'Telemetry read endpoints are only available to the hub owner'

const telemetryBodyLimit = bodyLimit({
    maxSize: TELEMETRY_BODY_LIMIT_BYTES,
    onError: (c) => c.json({ error: 'Request body too large' }, 413)
})

function parsePositiveInt(raw: string | undefined, fallback: number, max: number): number | null {
    if (raw === undefined || raw === '') return fallback
    const n = Number(raw)
    if (!Number.isInteger(n) || n < 1 || n > max) return null
    return n
}

function parseTimestamp(raw: string | undefined): number | null | undefined {
    if (raw === undefined || raw === '') return undefined
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
}

function utcDayOf(ts: number): string {
    return new Date(ts).toISOString().slice(0, 10)
}

function daysAgoDay(days: number, now: number): string {
    return utcDayOf(now - days * 86_400_000)
}

/**
 * P0 telemetry surface (research report §6.1): one ingest endpoint plus
 * owner-only read endpoints. P0 consumption is curl/SQLite; the web panel
 * (P1) will reuse these shapes.
 */
export function createTelemetryRoutes(store: Store, dataDir: string): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    // Ingest: any authenticated client may upload; namespace/userId are
    // stamped server-side from the JWT (never trusted from the body).
    app.post('/telemetry/events', telemetryBodyLimit, async (c) => {
        // Review finding #3: an unreadable settings.json must not 500 every
        // telemetry POST (features and bootstrap tolerate the same read).
        // Degrade to level 0 = collection off: the batch still gets a 200 so
        // the SDK drains its outbox, with every event in droppedByLevel.
        let level: TelemetryLevel = 0
        try {
            level = (await readTelemetryLevelState(dataDir)).level
        } catch {
            // keep 0
        }
        const json = await c.req.json().catch(() => null)
        const parsed = TelemetryBatchSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }
        // Level 0 (collection off) drops every event through the same
        // level-gate path — droppedByLevel stays honest and the client can
        // drain its outbox instead of retrying a "failed" upload.
        const result = store.telemetry.insertBatch(
            {
                namespace: c.get('namespace'),
                userId: c.get('userId'),
                level
            },
            parsed.data
        )
        return c.json({
            ok: true,
            accepted: result.accepted,
            rejected: result.rejected,
            droppedByLevel: result.droppedByLevel,
            level
        })
    })

    // ux/diag event aggregation (read-time SQL; ~800 rows/day makes a
    // materialized summary unnecessary — ruling §3.4 #4).
    app.get('/telemetry/summary', (c) => {
        if (c.get('namespace') !== 'default') {
            return c.json({ error: OWNER_ONLY_ERROR }, 403)
        }
        const domain = c.req.query('domain')
        if (domain !== 'ux' && domain !== 'diag') {
            return c.json({ error: 'domain must be ux or diag' }, 400)
        }
        const groupRaw = c.req.query('group') ?? 'kind'
        if (groupRaw !== 'session' && groupRaw !== 'kind' && groupRaw !== 'fingerprint') {
            return c.json({ error: 'group must be session, kind or fingerprint' }, 400)
        }
        const limit = parsePositiveInt(c.req.query('limit'), 100, 1000)
        if (limit === null) {
            return c.json({ error: 'Invalid limit' }, 400)
        }
        const since = parseTimestamp(c.req.query('since'))
        if (since === null) {
            return c.json({ error: 'Invalid since' }, 400)
        }
        const until = parseTimestamp(c.req.query('until'))
        if (until === null) {
            return c.json({ error: 'Invalid until' }, 400)
        }
        const rows = store.telemetry.eventSummary({
            namespace: c.get('namespace'),
            domain,
            group: groupRaw,
            since,
            until,
            limit
        })
        c.header('Cache-Control', 'no-store')
        return c.json({ domain, group: groupRaw, rows, limit })
    })

    // perf rollup aggregation: millisecond answers over permanent rollup rows.
    app.get('/telemetry/perf/summary', (c) => {
        if (c.get('namespace') !== 'default') {
            return c.json({ error: OWNER_ONLY_ERROR }, 403)
        }
        const group = c.req.query('group') ?? 'path'
        if (group !== 'path') {
            return c.json({ error: 'group must be path' }, 400)
        }
        const days = parsePositiveInt(c.req.query('days'), 7, 90)
        if (days === null) {
            return c.json({ error: 'Invalid days' }, 400)
        }
        const sourceRaw = c.req.query('source')
        if (sourceRaw !== undefined && sourceRaw !== '' && sourceRaw !== 'web' && sourceRaw !== 'hub') {
            return c.json({ error: 'source must be web or hub' }, 400)
        }
        const source = sourceRaw === 'web' || sourceRaw === 'hub' ? sourceRaw : undefined
        const rows = store.telemetry.rollupSummary({
            sinceDay: daysAgoDay(days, Date.now()),
            source
        })
        c.header('Cache-Control', 'no-store')
        // Cross-bucket percentiles are count-weighted approximations; exact
        // tails live in /telemetry/perf/slow over the raw window.
        return c.json({ days, source: source ?? 'all', approx: true, rows })
    })

    // Slowest raw samples (top total_ms inside the raw retention window).
    app.get('/telemetry/perf/slow', (c) => {
        if (c.get('namespace') !== 'default') {
            return c.json({ error: OWNER_ONLY_ERROR }, 403)
        }
        const limit = parsePositiveInt(c.req.query('limit'), 50, 500)
        if (limit === null) {
            return c.json({ error: 'Invalid limit' }, 400)
        }
        const sourceRaw = c.req.query('source')
        if (sourceRaw !== undefined && sourceRaw !== '' && sourceRaw !== 'web' && sourceRaw !== 'hub') {
            return c.json({ error: 'source must be web or hub' }, 400)
        }
        const source = sourceRaw === 'web' || sourceRaw === 'hub' ? sourceRaw : undefined
        const windowHours = perfRawWindowHours()
        const rows = store.telemetry.slowSamples({
            sinceTs: Date.now() - windowHours * 3_600_000,
            source,
            limit
        })
        c.header('Cache-Control', 'no-store')
        return c.json({ windowHours, rows })
    })

    return app
}
