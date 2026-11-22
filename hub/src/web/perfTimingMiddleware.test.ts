import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { WebAppEnv } from './middleware/auth'
import { createPerfTimingMiddleware, isHubPerfRecordablePath } from './perfTimingMiddleware'
import type { HubPerfSampleInput } from '../store/telemetry'

describe('isHubPerfRecordablePath (skip rules, ruling §3.4 #11)', () => {
    it('records only the /api and /cli planes', () => {
        expect(isHubPerfRecordablePath('/api/sessions')).toBe(true)
        expect(isHubPerfRecordablePath('/api')).toBe(true)
        expect(isHubPerfRecordablePath('/api/events')).toBe(true)
        expect(isHubPerfRecordablePath('/cli/sessions')).toBe(true)
        expect(isHubPerfRecordablePath('/cli')).toBe(true)
    })

    it('skips health, socket.io, static assets and the telemetry ingest itself', () => {
        expect(isHubPerfRecordablePath('/health')).toBe(false)
        expect(isHubPerfRecordablePath('/health/')).toBe(false)
        expect(isHubPerfRecordablePath('/socket.io/')).toBe(false)
        expect(isHubPerfRecordablePath('/socket.io/EIO=4')).toBe(false)
        expect(isHubPerfRecordablePath('/api/telemetry')).toBe(false)
        expect(isHubPerfRecordablePath('/api/telemetry/events')).toBe(false)
        expect(isHubPerfRecordablePath('/api/telemetry/perf/summary')).toBe(false)
        expect(isHubPerfRecordablePath('/assets/app.js')).toBe(false)
        expect(isHubPerfRecordablePath('/sw.js')).toBe(false)
        expect(isHubPerfRecordablePath('/')).toBe(false)
        expect(isHubPerfRecordablePath('/index.html')).toBe(false)
    })
})

describe('createPerfTimingMiddleware', () => {
    function createApp(options?: { recordError?: boolean }) {
        const recorded: HubPerfSampleInput[] = []
        const app = new Hono<WebAppEnv>()
        app.use('*', createPerfTimingMiddleware((sample) => {
            recorded.push(sample)
        }))
        app.use('/api/*', async (c, next) => {
            // Mimic the auth middleware: only authenticated paths get a ns.
            if (c.req.path !== '/api/auth') {
                c.set('namespace', 'default')
            }
            await next()
        })
        app.get('/api/sessions', (c) => c.json({ ok: true }))
        app.post('/api/auth', (c) => c.json({ token: 't' }))
        app.get('/api/boom', () => {
            throw new Error('boom')
        })
        app.get('/health', (c) => c.json({ status: 'ok' }))
        app.get('/api/telemetry/events', (c) => c.json({ ok: true }))
        if (options?.recordError !== false) {
            app.onError((error, c) => c.json({ error: String(error) }, 500))
        }
        return { app, recorded }
    }

    it('records /api requests with the authenticated namespace', async () => {
        const { app, recorded } = createApp()
        const response = await app.request('/api/sessions')
        expect(response.status).toBe(200)
        expect(recorded).toHaveLength(1)
        expect(recorded[0]).toMatchObject({
            method: 'GET',
            path: '/api/sessions',
            status: 200,
            namespace: 'default'
        })
        expect(recorded[0]!.totalMs).toBeGreaterThanOrEqual(0)
    })

    it('falls back to the web namespace on unauthenticated api paths', async () => {
        const { app, recorded } = createApp()
        await app.request('/api/auth', { method: 'POST' })
        expect(recorded).toHaveLength(1)
        expect(recorded[0]).toMatchObject({ path: '/api/auth', namespace: 'web' })
    })

    it('skips /health, the telemetry ingest and self-header uploads', async () => {
        const { app, recorded } = createApp()
        await app.request('/health')
        expect(recorded).toHaveLength(0)

        await app.request('/api/telemetry/events')
        expect(recorded).toHaveLength(0)

        await app.request('/api/sessions', {
            headers: { 'x-hapi-telemetry': '1' }
        })
        expect(recorded).toHaveLength(0)
    })

    it('echoes the trace header on responses that carried it', async () => {
        const { app, recorded } = createApp()
        const response = await app.request('/api/sessions', {
            headers: { 'x-hapi-trace-id': 'trace-abc-123' }
        })
        expect(response.headers.get('x-hapi-trace-id')).toBe('trace-abc-123')
        expect(recorded).toHaveLength(1)
        expect(recorded[0]!.traceId).toBe('trace-abc-123')
    })

    it('records the error response when a handler throws (fail-open for the request, fail-silent for telemetry)', async () => {
        const { app, recorded } = createApp()
        const response = await app.request('/api/boom')
        expect(response.status).toBe(500)
        expect(recorded).toHaveLength(1)
        // Hono's onError response is already on c.res when our finally block
        // observes it, so the sample carries the real 500 (status 0 only when
        // no response exists at all).
        expect(recorded[0]).toMatchObject({ path: '/api/boom', status: 500 })
    })

    it('never lets a throwing recorder break the request', async () => {
        const app = new Hono<WebAppEnv>()
        app.use('*', createPerfTimingMiddleware(() => {
            throw new Error('recorder exploded')
        }))
        app.get('/api/sessions', (c) => c.json({ ok: true }))
        const response = await app.request('/api/sessions')
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true })
    })

    it('stamps /cli rows with the literal cli namespace', async () => {
        const recorded: HubPerfSampleInput[] = []
        const app = new Hono<WebAppEnv>()
        app.use('*', createPerfTimingMiddleware((sample) => {
            recorded.push(sample)
        }))
        app.get('/cli/machines', (c) => c.json({ ok: true }))
        await app.request('/cli/machines')
        expect(recorded).toHaveLength(1)
        expect(recorded[0]).toMatchObject({ path: '/cli/machines', namespace: 'cli' })
    })

    it('skips CORS preflight OPTIONS requests but still echoes the trace header (review finding #5)', async () => {
        const recorded: HubPerfSampleInput[] = []
        const app = new Hono<WebAppEnv>()
        app.use('*', createPerfTimingMiddleware((sample) => {
            recorded.push(sample)
        }))
        app.options('/api/sessions', (c) => c.json({ ok: true }))
        app.get('/api/sessions', (c) => c.json({ ok: true }))

        const preflight = await app.request('/api/sessions', {
            method: 'OPTIONS',
            headers: { origin: 'https://web.example', 'x-hapi-trace-id': 'trace-opt-1' }
        })
        expect(preflight.status).toBe(200)
        // Preflight is not a business request: no perf row, but the harmless
        // pairing key is still echoed.
        expect(recorded).toHaveLength(0)
        expect(preflight.headers.get('x-hapi-trace-id')).toBe('trace-opt-1')

        // The next real request still records normally.
        await app.request('/api/sessions')
        expect(recorded).toHaveLength(1)
        expect(recorded[0]).toMatchObject({ method: 'GET', path: '/api/sessions' })
    })
})
