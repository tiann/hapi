/**
 * Wire-level tests: the real Http2ApnsClient talking to a real node:http2
 * mock server (h2c). This is also the living proof that Bun's node:http2
 * client implementation works for the relay's needs (verified on Bun 1.3.14);
 * if these tests ever start failing on a Bun upgrade, swap the transport
 * behind the ApnsClient interface (see relay/src/apns.ts header comment).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createServer } from 'node:http2'
import { decodeProtectedHeader, jwtVerify } from 'jose'
import {
    APNS_JWT_MAX_AGE_MS,
    ApnsJwtProvider,
    buildApnsPayload,
    Http2ApnsClient,
    truncateCollapseId,
    type ApnsPushRequest
} from './apns'
import { makeTestKeys, MockApnsServer, type TestKeys } from './testSupport/apnsTestUtils'

const KEY_ID = 'ABC123DEF4'
const TEAM_ID = 'TEAM123456'
const TOPIC = 'app.hapi.ios'
const DEVICE_TOKEN = 'ab12cd34'.repeat(8)

describe('buildApnsPayload', () => {
    test('produces the exact wire body from the contract', () => {
        expect(buildApnsPayload('BASE64BYTES')).toBe(
            '{"aps":{"mutable-content":1,"alert":{"title":"HAPI","body":"New activity"},'
            + '"sound":"default"},"hapi":{"v":1,"e":"BASE64BYTES"}}'
        )
    })
})

describe('truncateCollapseId', () => {
    test('leaves short ids untouched', () => {
        expect(truncateCollapseId('session-42')).toBe('session-42')
        expect(truncateCollapseId('x'.repeat(64))).toBe('x'.repeat(64))
    })

    test('truncates ASCII ids to 64 bytes', () => {
        expect(truncateCollapseId('x'.repeat(80))).toBe('x'.repeat(64))
    })

    test('never splits a multi-byte code point', () => {
        // Each euro sign is 3 UTF-8 bytes; 30 of them = 90 bytes.
        const truncated = truncateCollapseId('€'.repeat(30))
        expect(truncated).toBe('€'.repeat(21)) // 63 bytes - 64 would split
        expect(new TextEncoder().encode(truncated).byteLength).toBeLessThanOrEqual(64)
    })
})

describe('ApnsJwtProvider', () => {
    let keys: TestKeys

    beforeEach(async () => {
        keys = await makeTestKeys()
    })

    function makeProvider(now: () => number): ApnsJwtProvider {
        return new ApnsJwtProvider({
            privateKeyPem: keys.privateKeyPem,
            keyId: KEY_ID,
            teamId: TEAM_ID,
            now
        })
    }

    test('signs a verifiable ES256 JWT with kid, iss and iat', async () => {
        const nowMs = 1_700_000_000_000
        const provider = makeProvider(() => nowMs)
        const token = await provider.getToken()

        const header = decodeProtectedHeader(token)
        expect(header.alg).toBe('ES256')
        expect(header.kid).toBe(KEY_ID)

        const { payload } = await jwtVerify(token, keys.publicKey, {
            issuer: TEAM_ID,
            currentDate: new Date(nowMs)
        })
        expect(payload.iat).toBe(Math.floor(nowMs / 1000))
    })

    test('caches the token for 45 minutes, then regenerates', async () => {
        let nowMs = 1_700_000_000_000
        const provider = makeProvider(() => nowMs)
        const first = await provider.getToken()

        nowMs += 44 * 60 * 1000
        expect(await provider.getToken()).toBe(first) // still cached

        nowMs += 2 * 60 * 1000 // 46 minutes total, past the 45-minute budget
        const second = await provider.getToken()
        expect(second).not.toBe(first)
        const { payload } = await jwtVerify(second, keys.publicKey, {
            issuer: TEAM_ID,
            currentDate: new Date(nowMs)
        })
        expect(payload.iat).toBe(Math.floor(nowMs / 1000))
        expect(APNS_JWT_MAX_AGE_MS).toBe(45 * 60 * 1000)
    })

    test('invalidate() forces a fresh token', async () => {
        const nowMs = 1_700_000_000_000
        const provider = makeProvider(() => nowMs)
        const first = await provider.getToken()
        provider.invalidate()
        const second = await provider.getToken()
        // ECDSA signatures are randomized, so a re-signed token differs even
        // with identical claims.
        expect(second).not.toBe(first)
    })
})

describe('Http2ApnsClient against a node:http2 mock', () => {
    let mock: MockApnsServer
    let keys: TestKeys
    let client: Http2ApnsClient | undefined

    beforeEach(async () => {
        mock = new MockApnsServer()
        await mock.start()
        keys = await makeTestKeys()
    })

    afterEach(async () => {
        if (client !== undefined) {
            await client.close()
            client = undefined
        }
        await mock.stop()
    })

    function makeClient(overrides?: { baseUrl?: string; requestTimeoutMs?: number }): Http2ApnsClient {
        const made = new Http2ApnsClient({
            baseUrl: overrides?.baseUrl ?? mock.url,
            topic: TOPIC,
            jwtProvider: new ApnsJwtProvider({
                privateKeyPem: keys.privateKeyPem,
                keyId: KEY_ID,
                teamId: TEAM_ID
            }),
            requestTimeoutMs: overrides?.requestTimeoutMs ?? 5000,
            connectTimeoutMs: 5000
        })
        client = made
        return made
    }

    function basePush(overrides?: Partial<ApnsPushRequest>): ApnsPushRequest {
        return {
            deviceToken: DEVICE_TOKEN,
            payload: buildApnsPayload('RU5DUllQVEVE'),
            priority: 10,
            ...overrides
        }
    }

    test('sends the full APNs request shape and reports delivered', async () => {
        const result = await makeClient().push(basePush())
        expect(result).toEqual({ kind: 'delivered', apnsId: 'mock-apns-id' })

        expect(mock.requests.length).toBe(1)
        const seen = mock.requests[0]!
        expect(seen.headers[':method']).toBe('POST')
        expect(seen.headers[':path']).toBe(`/3/device/${DEVICE_TOKEN}`)
        expect(seen.headers['apns-topic']).toBe(TOPIC)
        expect(seen.headers['apns-push-type']).toBe('alert')
        expect(seen.headers['apns-priority']).toBe('10')
        expect(seen.headers['apns-expiration']).toBe('0')
        expect(seen.headers['content-type']).toBe('application/json')
        expect(seen.headers['apns-collapse-id']).toBeUndefined()
        expect(seen.body).toBe(buildApnsPayload('RU5DUllQVEVE'))

        const authorization = seen.headers.authorization
        expect(typeof authorization).toBe('string')
        expect(authorization!.startsWith('bearer ')).toBe(true)
        const jwt = authorization!.slice('bearer '.length)
        const header = decodeProtectedHeader(jwt)
        expect(header.alg).toBe('ES256')
        expect(header.kid).toBe(KEY_ID)
        const { payload } = await jwtVerify(jwt, keys.publicKey, { issuer: TEAM_ID })
        expect(typeof payload.iat).toBe('number')
    })

    test('passes priority 5 and truncates the collapse id to 64 bytes on the wire', async () => {
        const result = await makeClient().push(
            basePush({ priority: 5, collapseId: 'c'.repeat(80) })
        )
        expect(result.kind).toBe('delivered')
        const seen = mock.requests[0]!
        expect(seen.headers['apns-priority']).toBe('5')
        expect(seen.headers['apns-collapse-id']).toBe('c'.repeat(64))
    })

    test('reuses one HTTP/2 session and one JWT across pushes', async () => {
        const c = makeClient()
        expect((await c.push(basePush())).kind).toBe('delivered')
        expect((await c.push(basePush())).kind).toBe('delivered')
        expect(mock.requests.length).toBe(2)
        expect(mock.sessionCount).toBe(1)
        expect(mock.requests[0]!.headers.authorization)
            .toBe(mock.requests[1]!.headers.authorization)
    })

    test('maps APNs 410 Unregistered', async () => {
        mock.queueStatus(410, { reason: 'Unregistered', timestamp: 1_660_000_000_000 })
        const result = await makeClient().push(basePush())
        expect(result).toEqual({ kind: 'rejected', status: 410, reason: 'Unregistered' })
    })

    test('maps APNs 400 BadDeviceToken', async () => {
        mock.queueStatus(400, { reason: 'BadDeviceToken' })
        const result = await makeClient().push(basePush())
        expect(result).toEqual({ kind: 'rejected', status: 400, reason: 'BadDeviceToken' })
    })

    test('maps APNs 5xx, with and without a reason body', async () => {
        mock.queueStatus(503, { reason: 'ServiceUnavailable' })
        const c = makeClient()
        expect(await c.push(basePush())).toEqual({
            kind: 'rejected',
            status: 503,
            reason: 'ServiceUnavailable'
        })
        mock.queueStatus(500)
        expect(await c.push(basePush())).toEqual({
            kind: 'rejected',
            status: 500,
            reason: 'HTTP 500'
        })
    })

    test('retries once with a fresh JWT after ExpiredProviderToken', async () => {
        mock.queueStatus(403, { reason: 'ExpiredProviderToken' })
        // Second (unscripted) request gets the default 200.
        const result = await makeClient().push(basePush())
        expect(result.kind).toBe('delivered')
        expect(mock.requests.length).toBe(2)
        expect(typeof mock.requests[1]!.headers.authorization).toBe('string')
    })

    test('reports a transport error when the connection is refused', async () => {
        // Find a port that is definitely closed: bind an ephemeral one, then free it.
        const probe = createServer()
        await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()))
        const addr = probe.address()
        const deadPort = typeof addr === 'object' && addr !== null ? addr.port : 1
        await new Promise<void>((resolve) => probe.close(() => resolve()))

        const result = await makeClient({ baseUrl: `http://127.0.0.1:${deadPort}` })
            .push(basePush())
        expect(result.kind).toBe('transport-error')
    })

    test('reports a transport error when the server never answers', async () => {
        mock.queue(() => {
            // never respond
        })
        const result = await makeClient({ requestTimeoutMs: 250 }).push(basePush())
        expect(result.kind).toBe('transport-error')
        if (result.kind === 'transport-error') {
            expect(result.message).toContain('timed out')
        }
    })

    test('reports a transport error when the stream is reset without a response', async () => {
        mock.queue((stream) => {
            stream.close(8) // NGHTTP2_CANCEL
        })
        const result = await makeClient().push(basePush())
        expect(result.kind).toBe('transport-error')
    })
})
