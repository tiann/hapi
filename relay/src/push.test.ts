/**
 * Route-level tests for the relay app: validation matrix, APNs outcome
 * mapping, rate limiting with a fake clock, and log privacy. The APNs client
 * is faked here; the real HTTP/2 wire behavior is covered by apns.test.ts
 * and relay.integration.test.ts.
 */
import { describe, expect, test } from 'bun:test'
import type { ApnsClient, ApnsPushRequest, ApnsPushResult } from './apns'
import { IP_RATE_LIMIT, TOKEN_RATE_LIMIT } from './config'
import { createRelayApp, hashedTokenPrefix, resolveClientIp, SERVICE_NAME } from './index'
import { TokenBucketLimiter, type TokenBucketOptions } from './rateLimit'

const TOKEN = 'A1b2c3d4'.repeat(8) // 64 hex chars, mixed case
const ENVELOPE = Buffer.from('opaque-e2e-ciphertext-bytes-here').toString('base64')

class FakeApnsClient implements ApnsClient {
    readonly requests: ApnsPushRequest[] = []
    readonly nextResults: ApnsPushResult[] = []

    async push(request: ApnsPushRequest): Promise<ApnsPushResult> {
        this.requests.push(request)
        return this.nextResults.shift() ?? { kind: 'delivered' }
    }

    async close(): Promise<void> {}
}

type Harness = {
    app: ReturnType<typeof createRelayApp>
    apns: FakeApnsClient
    logs: string[]
    advance: (ms: number) => void
}

function makeHarness(overrides?: {
    tokenLimit?: TokenBucketOptions
    ipLimit?: TokenBucketOptions
}): Harness {
    let nowMs = 0
    const now = (): number => nowMs
    const apns = new FakeApnsClient()
    const logs: string[] = []
    const app = createRelayApp({
        apns,
        version: 'test-1',
        tokenLimiter: new TokenBucketLimiter({ ...(overrides?.tokenLimit ?? TOKEN_RATE_LIMIT), now }),
        ipLimiter: new TokenBucketLimiter({ ...(overrides?.ipLimit ?? IP_RATE_LIMIT), now }),
        log: (line) => logs.push(line)
    })
    return {
        app,
        apns,
        logs,
        advance: (ms) => {
            nowMs += ms
        }
    }
}

function pushRequest(body: unknown): Request {
    return new Request('http://relay.test/v1/push', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body)
    })
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
    expect(res.headers.get('content-type')).toBe('application/json')
    return await res.json() as Record<string, unknown>
}

describe('POST /v1/push validation', () => {
    const cases: Array<{
        name: string
        body: unknown
        status: number
        code: string
    }> = [
        { name: 'non-JSON body', body: 'not json{{', status: 400, code: 'bad_request' },
        { name: 'JSON array body', body: [1, 2], status: 400, code: 'bad_request' },
        { name: 'missing platform', body: { token: TOKEN, envelope: ENVELOPE }, status: 400, code: 'bad_request' },
        { name: 'unknown platform', body: { platform: 'web', token: TOKEN, envelope: ENVELOPE }, status: 400, code: 'bad_request' },
        { name: 'android platform (reserved)', body: { platform: 'android', token: TOKEN, envelope: ENVELOPE }, status: 501, code: 'unsupported_platform' },
        { name: 'missing token', body: { platform: 'ios', envelope: ENVELOPE }, status: 400, code: 'bad_request' },
        { name: 'non-string token', body: { platform: 'ios', token: 42, envelope: ENVELOPE }, status: 400, code: 'bad_request' },
        { name: 'non-hex token', body: { platform: 'ios', token: 'zz'.repeat(32), envelope: ENVELOPE }, status: 400, code: 'bad_request' },
        { name: 'odd-length token', body: { platform: 'ios', token: 'a'.repeat(63), envelope: ENVELOPE }, status: 400, code: 'bad_request' },
        { name: 'too-short token', body: { platform: 'ios', token: 'ab'.repeat(7), envelope: ENVELOPE }, status: 400, code: 'bad_request' },
        { name: 'too-long token', body: { platform: 'ios', token: 'ab'.repeat(257), envelope: ENVELOPE }, status: 400, code: 'bad_request' },
        { name: 'missing envelope', body: { platform: 'ios', token: TOKEN }, status: 400, code: 'bad_request' },
        { name: 'empty envelope', body: { platform: 'ios', token: TOKEN, envelope: '' }, status: 400, code: 'bad_request' },
        { name: 'envelope with invalid base64 chars', body: { platform: 'ios', token: TOKEN, envelope: 'AB!=' }, status: 400, code: 'bad_request' },
        { name: 'envelope with bad base64 length', body: { platform: 'ios', token: TOKEN, envelope: 'AAA' }, status: 400, code: 'bad_request' },
        { name: 'oversized envelope (3204 bytes)', body: { platform: 'ios', token: TOKEN, envelope: 'A'.repeat(3204) }, status: 413, code: 'too_large' },
        { name: 'invalid priority', body: { platform: 'ios', token: TOKEN, envelope: ENVELOPE, priority: 7 }, status: 400, code: 'bad_request' },
        { name: 'string priority', body: { platform: 'ios', token: TOKEN, envelope: ENVELOPE, priority: '10' }, status: 400, code: 'bad_request' },
        { name: 'non-string collapseId', body: { platform: 'ios', token: TOKEN, envelope: ENVELOPE, collapseId: 42 }, status: 400, code: 'bad_request' }
    ]

    test.each(cases)('$name -> $status $code', async ({ body, status, code }) => {
        const { app, apns } = makeHarness()
        const res = await app.handle(pushRequest(body), '1.2.3.4')
        expect(res.status).toBe(status)
        const parsed = await readJson(res)
        expect(parsed.ok).toBe(false)
        expect(parsed.code).toBe(code)
        expect(apns.requests.length).toBe(0) // nothing invalid reaches APNs
    })

    test('envelope of exactly 3200 bytes is accepted', async () => {
        const { app, apns } = makeHarness()
        const res = await app.handle(
            pushRequest({ platform: 'ios', token: TOKEN, envelope: 'A'.repeat(3200) }),
            '1.2.3.4'
        )
        expect(res.status).toBe(200)
        expect(await readJson(res)).toEqual({ ok: true })
        expect(apns.requests.length).toBe(1)
    })
})

describe('POST /v1/push forwarding', () => {
    test('forwards with defaults: lowercased token, priority 10, wrapped payload', async () => {
        const { app, apns } = makeHarness()
        const res = await app.handle(
            pushRequest({ platform: 'ios', token: TOKEN, envelope: ENVELOPE }),
            '1.2.3.4'
        )
        expect(res.status).toBe(200)
        expect(await readJson(res)).toEqual({ ok: true })

        expect(apns.requests.length).toBe(1)
        const sent = apns.requests[0]!
        expect(sent.deviceToken).toBe(TOKEN.toLowerCase())
        expect(sent.priority).toBe(10)
        expect(sent.collapseId).toBeUndefined()
        expect(JSON.parse(sent.payload)).toEqual({
            aps: {
                'mutable-content': 1,
                alert: { title: 'HAPI', body: 'New activity' },
                sound: 'default'
            },
            hapi: { v: 1, e: ENVELOPE }
        })
    })

    test('passes through priority 5 and collapseId', async () => {
        const { app, apns } = makeHarness()
        await app.handle(
            pushRequest({
                platform: 'ios',
                token: TOKEN,
                envelope: ENVELOPE,
                priority: 5,
                collapseId: 'session-42'
            }),
            '1.2.3.4'
        )
        const sent = apns.requests[0]!
        expect(sent.priority).toBe(5)
        expect(sent.collapseId).toBe('session-42')
    })

    const mappingCases: Array<{
        name: string
        result: ApnsPushResult
        status: number
        code: string | undefined
    }> = [
        { name: 'delivered', result: { kind: 'delivered' }, status: 200, code: undefined },
        { name: 'APNs 410 Unregistered', result: { kind: 'rejected', status: 410, reason: 'Unregistered' }, status: 410, code: 'unregistered' },
        { name: 'APNs 400 BadDeviceToken', result: { kind: 'rejected', status: 400, reason: 'BadDeviceToken' }, status: 410, code: 'unregistered' },
        { name: 'APNs 400 BadTopic (relay misconfig)', result: { kind: 'rejected', status: 400, reason: 'BadTopic' }, status: 502, code: 'upstream' },
        { name: 'APNs 403 InvalidProviderToken', result: { kind: 'rejected', status: 403, reason: 'InvalidProviderToken' }, status: 502, code: 'upstream' },
        { name: 'APNs 429 TooManyRequests', result: { kind: 'rejected', status: 429, reason: 'TooManyRequests' }, status: 429, code: 'rate_limited' },
        { name: 'APNs 500', result: { kind: 'rejected', status: 500, reason: 'InternalServerError' }, status: 502, code: 'upstream' },
        { name: 'APNs 503', result: { kind: 'rejected', status: 503, reason: 'ServiceUnavailable' }, status: 502, code: 'upstream' },
        { name: 'network failure', result: { kind: 'transport-error', message: 'connect ECONNREFUSED' }, status: 502, code: 'upstream' }
    ]

    test.each(mappingCases)('$name -> $status', async ({ result, status, code }) => {
        const { app, apns } = makeHarness()
        apns.nextResults.push(result)
        const res = await app.handle(
            pushRequest({ platform: 'ios', token: TOKEN, envelope: ENVELOPE }),
            '1.2.3.4'
        )
        expect(res.status).toBe(status)
        const parsed = await readJson(res)
        if (code === undefined) {
            expect(parsed).toEqual({ ok: true })
        } else {
            expect(parsed).toEqual({ ok: false, code })
        }
    })

    test('never logs the envelope or the raw device token', async () => {
        const { app, logs } = makeHarness()
        await app.handle(
            pushRequest({ platform: 'ios', token: TOKEN, envelope: ENVELOPE }),
            '1.2.3.4'
        )
        expect(logs.length).toBeGreaterThan(0)
        for (const line of logs) {
            expect(line).not.toContain(ENVELOPE)
            expect(line).not.toContain(TOKEN)
            expect(line).not.toContain(TOKEN.toLowerCase())
        }
        expect(logs.some((line) => line.includes(hashedTokenPrefix(TOKEN)))).toBe(true)
    })
})

describe('POST /v1/push rate limiting', () => {
    test('per-token: 31st push within a minute is rejected, other tokens unaffected', async () => {
        const { app, apns } = makeHarness()
        for (let i = 0; i < 30; i++) {
            const res = await app.handle(
                pushRequest({ platform: 'ios', token: TOKEN, envelope: ENVELOPE }),
                '1.2.3.4'
            )
            expect(res.status).toBe(200)
        }
        const limited = await app.handle(
            pushRequest({ platform: 'ios', token: TOKEN, envelope: ENVELOPE }),
            '1.2.3.4'
        )
        expect(limited.status).toBe(429)
        expect(await readJson(limited)).toEqual({ ok: false, code: 'rate_limited' })
        expect(apns.requests.length).toBe(30) // the limited push never reached APNs

        const otherToken = 'f'.repeat(64)
        const other = await app.handle(
            pushRequest({ platform: 'ios', token: otherToken, envelope: ENVELOPE }),
            '1.2.3.4'
        )
        expect(other.status).toBe(200)
    })

    test('per-token budget refills over time', async () => {
        const { app, advance } = makeHarness({
            tokenLimit: { capacity: 1, refillPerMinute: 60 }
        })
        const send = (): Promise<Response> => app.handle(
            pushRequest({ platform: 'ios', token: TOKEN, envelope: ENVELOPE }),
            '1.2.3.4'
        )
        expect((await send()).status).toBe(200)
        expect((await send()).status).toBe(429)
        advance(1000) // 60/min = 1 token per second
        expect((await send()).status).toBe(200)
    })

    test('per-IP: shared across tokens, isolated between IPs, refills over time', async () => {
        const { app, apns, advance } = makeHarness({
            ipLimit: { capacity: 2, refillPerMinute: 60 }
        })
        const send = (token: string, ip: string): Promise<Response> => app.handle(
            pushRequest({ platform: 'ios', token, envelope: ENVELOPE }),
            ip
        )
        const tokenA = 'a'.repeat(64)
        const tokenB = 'b'.repeat(64)
        const tokenC = 'c'.repeat(64)
        expect((await send(tokenA, '10.0.0.1')).status).toBe(200)
        expect((await send(tokenB, '10.0.0.1')).status).toBe(200)
        const limited = await send(tokenC, '10.0.0.1')
        expect(limited.status).toBe(429)
        expect(await readJson(limited)).toEqual({ ok: false, code: 'rate_limited' })
        expect(apns.requests.length).toBe(2)

        expect((await send(tokenC, '10.0.0.2')).status).toBe(200) // other IP unaffected
        advance(1000)
        expect((await send(tokenC, '10.0.0.1')).status).toBe(200) // refilled
    })

    test('a null client IP falls back to a shared bucket and still works', async () => {
        const { app } = makeHarness()
        const res = await app.handle(
            pushRequest({ platform: 'ios', token: TOKEN, envelope: ENVELOPE }),
            null
        )
        expect(res.status).toBe(200)
    })
})

describe('routing', () => {
    test('GET /health reports service and version', async () => {
        const { app } = makeHarness()
        const res = await app.handle(new Request('http://relay.test/health'), null)
        expect(res.status).toBe(200)
        expect(await readJson(res)).toEqual({
            status: 'ok',
            service: SERVICE_NAME,
            version: 'test-1'
        })
    })

    test('wrong methods and unknown paths', async () => {
        const { app } = makeHarness()
        const getPush = await app.handle(new Request('http://relay.test/v1/push'), null)
        expect(getPush.status).toBe(405)
        const postHealth = await app.handle(
            new Request('http://relay.test/health', { method: 'POST' }),
            null
        )
        expect(postHealth.status).toBe(405)
        const unknown = await app.handle(new Request('http://relay.test/nope'), null)
        expect(unknown.status).toBe(404)
        expect(await readJson(unknown)).toEqual({ ok: false, code: 'not_found' })
    })
})

describe('resolveClientIp', () => {
    const server = (address: string | null): { requestIP: () => { address: string } | null } => ({
        requestIP: () => (address === null ? null : { address })
    })

    test('uses the socket address by default, ignoring x-forwarded-for', () => {
        const req = new Request('http://relay.test/v1/push', {
            headers: { 'x-forwarded-for': '6.6.6.6, 7.7.7.7' }
        })
        expect(resolveClientIp(req, server('9.9.9.9'), false)).toBe('9.9.9.9')
    })

    test('honors the first x-forwarded-for hop when trustProxy is on', () => {
        const req = new Request('http://relay.test/v1/push', {
            headers: { 'x-forwarded-for': '6.6.6.6, 7.7.7.7' }
        })
        expect(resolveClientIp(req, server('9.9.9.9'), true)).toBe('6.6.6.6')
    })

    test('falls back to the socket when trustProxy is on but no header is present', () => {
        const req = new Request('http://relay.test/v1/push')
        expect(resolveClientIp(req, server('9.9.9.9'), true)).toBe('9.9.9.9')
        expect(resolveClientIp(req, server(null), true)).toBeNull()
    })
})
