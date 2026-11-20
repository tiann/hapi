import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HTTP_BODY_READ_TIMEOUT_MS, state } from './state'
import { TELEMETRY_SELF_HEADER, TELEMETRY_TRACE_HEADER } from '@hapi/protocol/telemetry'
import { fetchThroughAuthProxy } from '@/api/authProxy'
import { noteBearerFromHeaders } from './httpObserver'
import { queuedEventsForTest } from './queue'
import {
    installForTest,
    resetTelemetryForTest,
    stubTelemetryFetch,
    type TelemetryFetchKit,
} from './testHelpers'

/**
 * Single-point fetch observation through authProxy: one perf http row per
 * request with ttfb/total/status/bytes/trace header/trigger/attempt/phase,
 * Bearer harvesting, self-exemption and the network-error path.
 */

let kit: TelemetryFetchKit
/** (url, init) pairs seen by the custom fetch installed per test. */
let wireCalls: Array<{ url: string; init?: RequestInit }>

beforeEach(async () => {
    kit = stubTelemetryFetch({ level: 1 })
    installForTest(kit)
    wireCalls = []
    // Let the install-time capability probe (and its fresh-enable flush) fully
    // settle before each test replaces fetch with a precise mock.
    await settle()
    await settle()
})

afterEach(() => {
    kit.restore()
    resetTelemetryForTest()
})

async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0))
}

/** Drop the kit's generic fetch and install a precise per-test mock. */
function useCustomFetch(handler: (url: string, init?: RequestInit) => Promise<Response> | Response): void {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        wireCalls.push({ url, init })
        return await handler(url, init)
    }) as typeof globalThis.fetch
}

function httpEvents(): Array<Record<string, unknown>> {
    return queuedEventsForTest().filter((e) => e.kind === 'http').map((e) => e.data)
}

describe('successful requests', () => {
    it('produces exactly one http row with the full field set', async () => {
        useCustomFetch(() => new Response('{"ok":1}', { status: 200, headers: { 'content-length': '7' } }))
        telemetryTrigger('session-open')
        const res = await fetchThroughAuthProxy('/api/sessions/11111111-2222-4333-8444-555566667777/messages?token=secret', {
            method: 'POST',
            headers: { authorization: 'Bearer jwt-abc' },
            body: JSON.stringify({ q: 'x' }),
        })
        await res.json()
        await settle()

        expect(httpEvents()).toHaveLength(1)
        const row = httpEvents()[0]!
        expect(row.method).toBe('POST')
        // uuid folded + query (token!) stripped entirely
        expect(row.pathTpl).toBe('/api/sessions/:id/messages')
        expect(row.status).toBe(200)
        expect(row.ttfbMs).toBeGreaterThanOrEqual(0)
        expect(row.totalMs).toBeGreaterThanOrEqual(0)
        expect(row.reqBytes).toBe(JSON.stringify({ q: 'x' }).length)
        expect(row.resBytes).toBe(7)
        expect(row.resBytesSource).toBe('content-length')
        expect(row.trigger).toBe('session-open')
        expect(typeof row.traceId).toBe('string')
        expect(row.phase).toBeUndefined()
        expect(row.cacheHit).toBeUndefined() // jsdom has no resource timing
        // trace header actually went on the wire and matches the row
        const sentInit = wireCalls[0]?.init as RequestInit
        const headers = new Headers(sentInit.headers)
        expect(headers.get(TELEMETRY_TRACE_HEADER)).toBe(row.traceId)
        // Bearer token harvested for the SDK uplink
        expect(state.lastSeenBearer).toBe('jwt-abc')
    })

    it('trigger defaults to null (column omitted)', async () => {
        useCustomFetch(() => new Response('{}', { status: 200 }))
        const res = await fetchThroughAuthProxy('/api/machines')
        await res.json()
        await settle()
        expect(httpEvents()[0]?.trigger).toBeUndefined()
    })

    it('rounds the timing triple and stays ≥ 0', async () => {
        useCustomFetch(() => new Response('{}', { status: 200 }))
        const res = await fetchThroughAuthProxy('/api/sessions')
        await res.text()
        await settle()
        const row = httpEvents()[0]!
        expect(Number.isInteger(row.ttfbMs)).toBe(true)
        expect(Number.isInteger(row.totalMs)).toBe(true)
        expect(row.totalMs as number).toBeGreaterThanOrEqual(row.ttfbMs as number)
    })
})

describe('self-exemption', () => {
    it('never observes, traces or harvests the SDK own uplink', async () => {
        useCustomFetch(() => new Response('{}', { status: 200 }))
        const res = await fetchThroughAuthProxy('/api/telemetry/events', {
            headers: { authorization: 'Bearer sdk-token', [TELEMETRY_SELF_HEADER]: '1' },
        })
        await res.json()
        await settle()
        expect(httpEvents()).toHaveLength(0)
        expect(state.lastSeenBearer).toBeNull()
        const sentInit = wireCalls[0]?.init as RequestInit
        expect(new Headers(sentInit.headers).has(TELEMETRY_TRACE_HEADER)).toBe(false)
    })
})

describe('failure paths', () => {
    it('network throw → status 0 + phase network, rethrown untouched', async () => {
        useCustomFetch(() => {
            throw new TypeError('Failed to fetch')
        })
        // The FIRST fetch's network error propagates raw (only the redirect
        // retry converts TypeError — original authProxy semantics, untouched).
        await expect(
            fetchThroughAuthProxy('https://hub.example/api/sessions', { headers: { authorization: 'Bearer t' } })
        ).rejects.toThrow('Failed to fetch')
        await settle()
        expect(httpEvents()).toHaveLength(1)
        const row = httpEvents()[0]!
        expect(row.status).toBe(0)
        expect(row.phase).toBe('network')
        expect(row.pathTpl).toBe('/api/sessions')
    })

    it('non-2xx → phase http + machine code from the error body (never the body itself)', async () => {
        useCustomFetch(() => new Response(JSON.stringify({ error: 'boom', code: 'not_found' }), { status: 404 }))
        const res = await fetchThroughAuthProxy('/api/sessions/abc')
        await res.text()
        await settle()
        const row = httpEvents()[0]!
        expect(row.status).toBe(404)
        expect(row.phase).toBe('http')
        expect(row.code).toBe('not_found')
    })

    it('body read rejection on an ok response → phase parse', async () => {
        useCustomFetch(() => new Response('not json', { status: 200 }))
        const res = await fetchThroughAuthProxy('/api/sessions')
        await expect(res.json()).rejects.toThrow()
        await settle()
        const row = httpEvents()[0]!
        expect(row.status).toBe(200)
        expect(row.phase).toBe('parse')
    })
})

describe('attempt counting (opaqueredirect retry)', () => {
    it('records attempt=2 when the redirect retry succeeds and traces both legs', async () => {
        let call = 0
        useCustomFetch(() => {
            call += 1
            if (call === 1) return { type: 'opaqueredirect', status: 0, ok: false } as Response
            return new Response('{}', { status: 200 })
        })
        const res = await fetchThroughAuthProxy('https://hub.example/api/auth', { method: 'POST', body: '{}' })
        await res.json()
        await settle()
        expect(call).toBe(2)
        const row = httpEvents()[0]!
        expect(row.attempt).toBe(2)
        const traceIds = wireCalls.map((c) => new Headers(c.init?.headers).get(TELEMETRY_TRACE_HEADER))
        expect(traceIds[0]).toBeTruthy()
        expect(traceIds[1]).toBe(traceIds[0])
    })
})

describe('trace header negotiation gating', () => {
    it('does not inject the trace header while telemetry is un-negotiated/disabled (old hub safety)', async () => {
        // A new web build pointed at an old hub must not attach the custom
        // header at all — the CORS preflight would reject it and every fetch
        // (hence the whole app) would fail.
        state.enabled = false
        state.level = 0
        useCustomFetch(() => new Response('{}', { status: 200 }))
        const res = await fetchThroughAuthProxy('/api/sessions')
        await res.json()
        await settle()
        const sentInit = wireCalls[0]?.init as RequestInit
        expect(new Headers(sentInit.headers).has(TELEMETRY_TRACE_HEADER)).toBe(false)
    })

    it('injects the trace header once negotiated (enabled && level > 0)', async () => {
        useCustomFetch(() => new Response('{}', { status: 200 }))
        const res = await fetchThroughAuthProxy('/api/sessions')
        await res.json()
        await settle()
        const sentInit = wireCalls[0]?.init as RequestInit
        expect(new Headers(sentInit.headers).has(TELEMETRY_TRACE_HEADER)).toBe(true)
    })
})

describe('unread response body', () => {
    it('reports totalMs = ttfb with code body-unread instead of the 15s fallback', async () => {
        vi.useFakeTimers()
        try {
            useCustomFetch(() => new Response('{}', { status: 200 }))
            const res = await fetchThroughAuthProxy('/api/sessions')
            void res // body deliberately never consumed (304 images, first-401 of a refresh retry)
            await vi.advanceTimersByTimeAsync(HTTP_BODY_READ_TIMEOUT_MS + 100)
            const row = httpEvents()[0]!
            expect(row.code).toBe('body-unread')
            expect(row.phase).toBe('http')
            expect(row.totalMs).toBe(row.ttfbMs)
            expect(row.totalMs as number).toBeLessThan(HTTP_BODY_READ_TIMEOUT_MS)
        } finally {
            vi.useRealTimers()
        }
    })
})

describe('Bearer harvesting helper', () => {
    it('ignores non-Bearer schemes and empty values', () => {
        noteBearerFromHeaders(new Headers({ authorization: 'Basic xyz' }))
        expect(state.lastSeenBearer).toBeNull()
        noteBearerFromHeaders(new Headers({}))
        expect(state.lastSeenBearer).toBeNull()
        noteBearerFromHeaders(new Headers({ authorization: 'Bearer tok-1' }))
        expect(state.lastSeenBearer).toBe('tok-1')
    })
})

function telemetryTrigger(trigger: string): void {
    state.trigger = trigger
}
