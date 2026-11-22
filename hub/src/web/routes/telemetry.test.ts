import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import type { TelemetryBatch, TelemetryEvent } from '@hapi/protocol/telemetry'
import { TELEMETRY_BODY_LIMIT_BYTES } from '@hapi/protocol/telemetry'
import type { WebAppEnv } from '../middleware/auth'
import { createAuthMiddleware } from '../middleware/auth'
import { Store } from '../../store'
import { createTelemetryRoutes } from './telemetry'
import { createHubSettingsRoutes } from './hubSettings'
import { writeTelemetryLevel } from '../../config/telemetryLevel'
import { __resetSettingsReadCacheForTests, getSettingsFile } from '../../config/settings'

const JWT_SECRET = new TextEncoder().encode('test-secret')
const directories: string[] = []

afterEach(async () => {
    await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function authHeaders(namespace = 'default', userId = 1) {
    const token = await new SignJWT({ uid: userId, ns: namespace })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(JWT_SECRET)
    return { authorization: `Bearer ${token}` }
}

async function createApp(store: Store) {
    const dataDir = await mkdtemp(join(tmpdir(), 'hapi-telemetry-routes-'))
    directories.push(dataDir)
    // Product default is now 0 (opt-in developer mode); pin L1 explicitly so
    // these ingest tests keep exercising the accepting path.
    await writeTelemetryLevel(dataDir, 1)
    const app = new Hono<WebAppEnv>()
    app.use('/api/*', createAuthMiddleware(JWT_SECRET))
    app.route('/api', createTelemetryRoutes(store, dataDir))
    return { app, dataDir }
}

let eventSeq = 0
function uxEvent(sessionId?: string): TelemetryEvent {
    eventSeq += 1
    return {
        id: `evt-${eventSeq}`,
        ts: Date.now(),
        seq: eventSeq,
        domain: 'ux',
        kind: 'session_open',
        level: 1,
        sessionId,
        data: { entry: 'list-click', openedAt: Date.now() }
    }
}

function diagErrorEvent(fingerprint: string): TelemetryEvent {
    eventSeq += 1
    return {
        id: `evt-${eventSeq}`,
        ts: Date.now(),
        seq: eventSeq,
        domain: 'diag',
        kind: 'js_error',
        level: 1,
        severity: 'error',
        fingerprint,
        data: { name: 'TypeError', messageHead: 'x is not a function' }
    }
}

function httpEvent(totalMs: number): TelemetryEvent {
    eventSeq += 1
    return {
        id: `evt-${eventSeq}`,
        ts: Date.now(),
        seq: eventSeq,
        domain: 'perf',
        kind: 'http',
        level: 1,
        data: { method: 'GET', pathTpl: '/api/sessions', status: 200, totalMs }
    }
}

function batch(events: TelemetryEvent[]): TelemetryBatch {
    return {
        schema: 1,
        device: { id: 'dev-1', kind: 'pwa', origin: 'cf-orange' },
        appVersion: '0.36.5-test',
        events
    }
}

async function postBatch(app: Hono<WebAppEnv>, body: unknown, headers: Record<string, string> = {}) {
    return app.request('/api/telemetry/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body)
    })
}

describe('POST /api/telemetry/events', () => {
    it('accepts a valid batch and reports the ingest counts', async () => {
        const store = new Store(':memory:')
        try {
            const { app } = await createApp(store)
            const response = await postBatch(app, batch([
                uxEvent('sess-1'),
                httpEvent(120),
                { id: 'bad-kind', ts: Date.now(), seq: 9, domain: 'ux', kind: 'bogus', level: 1, data: {} }
            ]), await authHeaders())
            expect(response.status).toBe(200)
            expect(await response.json()).toEqual({
                ok: true,
                accepted: 2,
                rejected: 1,
                droppedByLevel: 0,
                level: 1
            })
        } finally {
            store.close()
        }
    })

    it('requires a JWT (401 without authorization)', async () => {
        const store = new Store(':memory:')
        try {
            const { app } = await createApp(store)
            const response = await postBatch(app, batch([uxEvent()]))
            expect(response.status).toBe(401)
        } finally {
            store.close()
        }
    })

    it('rejects a malformed envelope with 400', async () => {
        const store = new Store(':memory:')
        try {
            const { app } = await createApp(store)
            const response = await postBatch(app, { schema: 2, device: {}, events: 'nope' }, await authHeaders())
            expect(response.status).toBe(400)
            const body = await response.json() as { error: string }
            expect(body.error).toBe('Invalid body')
        } finally {
            store.close()
        }
    })

    it('refuses bodies over the telemetry body limit with 413', async () => {
        const store = new Store(':memory:')
        try {
            const { app } = await createApp(store)
            const oversized = JSON.stringify(batch([uxEvent()])).slice(0, -1)
                + ',' + JSON.stringify({ padding: 'x'.repeat(TELEMETRY_BODY_LIMIT_BYTES) }) + '}'
            const response = await app.request('/api/telemetry/events', {
                method: 'POST',
                headers: {
                    ...(await authHeaders()),
                    'content-type': 'application/json',
                    'content-length': String(oversized.length)
                },
                body: oversized
            })
            expect(response.status).toBe(413)
        } finally {
            store.close()
        }
    })

    it('drops every event at level 0 and reports them in droppedByLevel', async () => {
        const store = new Store(':memory:')
        try {
            const { app, dataDir } = await createApp(store)
            await writeTelemetryLevel(dataDir, 0)
            const response = await postBatch(app, batch([uxEvent(), httpEvent(50)]), await authHeaders())
            expect(response.status).toBe(200)
            expect(await response.json()).toEqual({
                ok: true,
                accepted: 0,
                rejected: 0,
                droppedByLevel: 2,
                level: 0
            })
        } finally {
            store.close()
        }
    })

    it('still answers 200 when settings.json is unreadable (review finding #3)', async () => {
        const store = new Store(':memory:')
        try {
            const { app, dataDir } = await createApp(store)
            await writeFile(getSettingsFile(dataDir), '{corrupted', 'utf8')
            // Force a cold read: the write-through cache still holds the
            // fresh snapshot from createApp's writeTelemetryLevel.
            __resetSettingsReadCacheForTests()
            const response = await postBatch(app, batch([uxEvent(), httpEvent(50)]), await authHeaders())
            expect(response.status).toBe(200)
            // Degraded to level 0 = off: the batch is accepted (200) so the
            // SDK drains its outbox, everything lands in droppedByLevel.
            expect(await response.json()).toEqual({
                ok: true,
                accepted: 0,
                rejected: 0,
                droppedByLevel: 2,
                level: 0
            })
        } finally {
            store.close()
        }
    })

    it('rejects a poisoned ts (1e300) per event without 500ing the batch (review finding #2)', async () => {
        const store = new Store(':memory:')
        try {
            const { app } = await createApp(store)
            const good = Array.from({ length: 63 }, (_, i) => httpEvent(i + 1))
            const poisoned: TelemetryEvent = {
                id: 'evt-poison',
                ts: 1e300,
                seq: 99,
                domain: 'perf',
                kind: 'http',
                level: 1,
                data: { method: 'GET', pathTpl: '/api/sessions', status: 200, totalMs: 10 }
            }
            const response = await postBatch(app, batch([...good, poisoned]), await authHeaders())
            expect(response.status).toBe(200)
            expect(await response.json()).toEqual({
                ok: true,
                accepted: 63,
                rejected: 1,
                droppedByLevel: 0,
                level: 1
            })
        } finally {
            store.close()
        }
    })
})

describe('GET /api/telemetry/summary', () => {
    it('aggregates diag events by fingerprint for the owner', async () => {
        const store = new Store(':memory:')
        try {
            const { app } = await createApp(store)
            await postBatch(app, batch([
                diagErrorEvent('TypeError:abcd'),
                diagErrorEvent('TypeError:abcd'),
                diagErrorEvent('RangeError:ef01')
            ]), await authHeaders())

            const response = await app.request('/api/telemetry/summary?domain=diag&group=fingerprint', {
                headers: await authHeaders()
            })
            expect(response.status).toBe(200)
            const body = await response.json() as {
                domain: string
                group: string
                rows: Array<{ key: string; count: number; errorCount: number; firstTs: number; lastTs: number }>
            }
            expect(body.domain).toBe('diag')
            expect(body.group).toBe('fingerprint')
            expect(body.rows).toHaveLength(2)
            expect(body.rows[0]).toMatchObject({ key: 'TypeError:abcd', count: 2, errorCount: 2 })
            expect(body.rows[1]).toMatchObject({ key: 'RangeError:ef01', count: 1, errorCount: 1 })
        } finally {
            store.close()
        }
    })

    it('rejects tenants (owner-only) and invalid domains', async () => {
        const store = new Store(':memory:')
        try {
            const { app } = await createApp(store)
            const tenantHeaders = await authHeaders('tenant')
            const forbidden = await app.request('/api/telemetry/summary?domain=ux', { headers: tenantHeaders })
            expect(forbidden.status).toBe(403)

            const badDomain = await app.request('/api/telemetry/summary?domain=perf', {
                headers: await authHeaders()
            })
            expect(badDomain.status).toBe(400)
        } finally {
            store.close()
        }
    })

    it('groups ux events by session', async () => {
        const store = new Store(':memory:')
        try {
            const { app } = await createApp(store)
            await postBatch(app, batch([uxEvent('sess-a'), uxEvent('sess-a'), uxEvent('sess-b')]), await authHeaders())
            const response = await app.request('/api/telemetry/summary?domain=ux&group=session', {
                headers: await authHeaders()
            })
            expect(response.status).toBe(200)
            const body = await response.json() as { rows: Array<{ key: string; count: number }> }
            expect(body.rows).toEqual([
                expect.objectContaining({ key: 'sess-a', count: 2 }),
                expect.objectContaining({ key: 'sess-b', count: 1 })
            ])
        } finally {
            store.close()
        }
    })
})

describe('GET /api/telemetry/perf/*', () => {
    it('serves rollup summaries with the approx marker', async () => {
        const store = new Store(':memory:')
        try {
            const { app } = await createApp(store)
            // 20 same-bucket samples → P50=10, P95=19 (nearest-rank).
            await postBatch(app, batch(Array.from({ length: 20 }, (_, i) => httpEvent(i + 1))), await authHeaders())
            store.telemetry.tick(Date.now() + 1_000)

            const response = await app.request('/api/telemetry/perf/summary?days=7', {
                headers: await authHeaders()
            })
            expect(response.status).toBe(200)
            const body = await response.json() as {
                days: number
                source: string
                approx: boolean
                rows: Array<{ pathTpl: string; sampleCount: number; p95Ms: number }>
            }
            expect(body.approx).toBe(true)
            expect(body.source).toBe('all')
            expect(body.rows).toHaveLength(1)
            expect(body.rows[0]).toMatchObject({
                pathTpl: '/api/sessions',
                sampleCount: 20,
                p95Ms: 19
            })
        } finally {
            store.close()
        }
    })

    it('lists the slowest raw samples newest-window scoped', async () => {
        const store = new Store(':memory:')
        try {
            const { app } = await createApp(store)
            await postBatch(app, batch([httpEvent(30), httpEvent(4_000), httpEvent(900)]), await authHeaders())
            store.telemetry.tick(Date.now() + 1_000)

            const response = await app.request('/api/telemetry/perf/slow?limit=2', {
                headers: await authHeaders()
            })
            expect(response.status).toBe(200)
            const body = await response.json() as {
                windowHours: number
                rows: Array<{ totalMs: number; source: string; pathTpl: string }>
            }
            expect(body.windowHours).toBe(48)
            expect(body.rows.map((row) => row.totalMs)).toEqual([4_000, 900])
            expect(body.rows[0]).toMatchObject({ source: 'web', pathTpl: '/api/sessions' })
        } finally {
            store.close()
        }
    })

    it('is owner-only', async () => {
        const store = new Store(':memory:')
        try {
            const { app } = await createApp(store)
            const tenant = await authHeaders('tenant')
            expect((await app.request('/api/telemetry/perf/summary', { headers: tenant })).status).toBe(403)
            expect((await app.request('/api/telemetry/perf/slow', { headers: tenant })).status).toBe(403)
        } finally {
            store.close()
        }
    })
})

describe('telemetry level via hub-settings patch', () => {
    it('persists telemetryLevel alone and rejects combined updates', async () => {
        const store = new Store(':memory:')
        try {
            const { dataDir } = await createApp(store)
            const settingsApp = new Hono<WebAppEnv>()
            settingsApp.use('*', async (c, next) => {
                c.set('namespace', 'default')
                c.set('userId', 1)
                await next()
            })
            settingsApp.route('/api', createHubSettingsRoutes(dataDir, undefined, store))

            const patch = await settingsApp.request('/api/hub-settings', {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ telemetryLevel: 2 })
            })
            expect(patch.status).toBe(200)
            const patched = await patch.json() as { telemetryLevel: number; telemetryLevelSource: string }
            expect(patched.telemetryLevel).toBe(2)
            expect(patched.telemetryLevelSource).toBe('file')

            const persisted = JSON.parse(await readFile(getSettingsFile(dataDir), 'utf8')) as {
                telemetryLevel?: number
                telemetryLevelChangedAt?: number
            }
            expect(persisted.telemetryLevel).toBe(2)
            expect(typeof persisted.telemetryLevelChangedAt).toBe('number')

            const combined = await settingsApp.request('/api/hub-settings', {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ telemetryLevel: 3, sessionSummaryContract: true })
            })
            expect(combined.status).toBe(400)

            const invalid = await settingsApp.request('/api/hub-settings', {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ telemetryLevel: 7 })
            })
            expect(invalid.status).toBe(400)
        } finally {
            store.close()
        }
    })

    it('flips the hub-plane perf level gate immediately after the PUT (review finding #1)', async () => {
        const store = new Store(':memory:')
        try {
            // Fresh dataDir, default level 0: the hub-plane gate is closed.
            const dataDir = await mkdtemp(join(tmpdir(), 'hapi-telemetry-routes-'))
            directories.push(dataDir)
            const settingsApp = new Hono<WebAppEnv>()
            settingsApp.use('*', async (c, next) => {
                c.set('namespace', 'default')
                c.set('userId', 1)
                await next()
            })
            settingsApp.route('/api', createHubSettingsRoutes(dataDir, undefined, store))

            const sample = {
                ts: Date.now(),
                method: 'GET',
                path: '/api/sessions',
                status: 200,
                totalMs: 4_000,
                namespace: 'default'
            }
            store.telemetry.recordHubSample(sample)
            expect(store.telemetry.hubQueueStats().queued).toBe(0)

            const patch = await settingsApp.request('/api/hub-settings', {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ telemetryLevel: 1 })
            })
            expect(patch.status).toBe(200)

            // Same tick cadence as the engine would run: without the eager
            // route-side refresh this would still be gated at the stale 0.
            store.telemetry.recordHubSample(sample)
            expect(store.telemetry.hubQueueStats().queued).toBe(1)
            store.telemetry.tick(Date.now() + 1_000)
            expect(store.telemetry.hubQueueStats().queued).toBe(0)
        } finally {
            store.close()
        }
    })
})
