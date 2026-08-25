/**
 * Glue test: the real relay app wired to the real Http2ApnsClient, talking
 * to the node:http2 APNs mock - the full path a hub's POST /v1/push takes,
 * minus TLS and Bun.serve socket plumbing (covered by Bun itself).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { ApnsJwtProvider, Http2ApnsClient } from './apns'
import { IP_RATE_LIMIT, TOKEN_RATE_LIMIT } from './config'
import { createRelayApp } from './index'
import { TokenBucketLimiter } from './rateLimit'
import { makeTestKeys, MockApnsServer } from './testSupport/apnsTestUtils'

const TOKEN = '0f'.repeat(32)
const ENVELOPE = Buffer.from('aes-256-gcm-ciphertext').toString('base64')

describe('relay end to end (mock APNs)', () => {
    let mock: MockApnsServer
    let client: Http2ApnsClient
    let app: ReturnType<typeof createRelayApp>

    beforeEach(async () => {
        mock = new MockApnsServer()
        await mock.start()
        const keys = await makeTestKeys()
        client = new Http2ApnsClient({
            baseUrl: mock.url,
            topic: 'app.hapi.ios',
            jwtProvider: new ApnsJwtProvider({
                privateKeyPem: keys.privateKeyPem,
                keyId: 'ABC123DEF4',
                teamId: 'TEAM123456'
            }),
            requestTimeoutMs: 5000,
            connectTimeoutMs: 5000
        })
        app = createRelayApp({
            apns: client,
            version: 'it-test',
            tokenLimiter: new TokenBucketLimiter(TOKEN_RATE_LIMIT),
            ipLimiter: new TokenBucketLimiter(IP_RATE_LIMIT),
            log: () => {}
        })
    })

    afterEach(async () => {
        await client.close()
        await mock.stop()
    })

    function push(body: unknown): Promise<Response> {
        return app.handle(
            new Request('http://relay.test/v1/push', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body)
            }),
            '203.0.113.7'
        )
    }

    test('a valid push travels to APNs and comes back ok', async () => {
        const res = await push({
            platform: 'ios',
            token: TOKEN.toUpperCase(),
            envelope: ENVELOPE,
            collapseId: 'sess-1'
        })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ ok: true })

        expect(mock.requests.length).toBe(1)
        const seen = mock.requests[0]!
        expect(seen.headers[':path']).toBe(`/3/device/${TOKEN}`) // lowercased
        expect(seen.headers['apns-collapse-id']).toBe('sess-1')
        const body = JSON.parse(seen.body) as { hapi: { v: number; e: string } }
        expect(body.hapi.v).toBe(1)
        expect(body.hapi.e).toBe(ENVELOPE)
    })

    test('an APNs Unregistered answer surfaces as 410 unregistered', async () => {
        mock.queueStatus(410, { reason: 'Unregistered', timestamp: 1_660_000_000_000 })
        const res = await push({ platform: 'ios', token: TOKEN, envelope: ENVELOPE })
        expect(res.status).toBe(410)
        expect(await res.json()).toEqual({ ok: false, code: 'unregistered' })
    })

    test('health stays up regardless of APNs', async () => {
        const res = await app.handle(new Request('http://relay.test/health'), null)
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            status: 'ok',
            service: 'hapi-push-relay',
            version: 'it-test'
        })
    })
})
