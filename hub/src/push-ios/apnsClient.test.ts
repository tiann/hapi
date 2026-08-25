import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import http2 from 'node:http2'
import { generateKeyPairSync } from 'node:crypto'
import * as jose from 'jose'

import {
    APNS_JWT_MAX_AGE_MS,
    ApnsClient,
    ApnsJwtProvider,
    buildApnsRequestBody
} from './apnsClient'

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const TEST_KEY_P8 = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string

describe('ApnsJwtProvider', () => {
    it('mints an ES256 JWT with the APNs header/claims shape and a valid signature', async () => {
        const provider = new ApnsJwtProvider(TEST_KEY_P8, 'KEYID12345', 'TEAMID9999')
        const nowMs = 1_700_000_000_123
        const token = await provider.getToken(nowMs)

        const header = jose.decodeProtectedHeader(token)
        expect(header).toEqual({ alg: 'ES256', kid: 'KEYID12345' })

        const claims = jose.decodeJwt(token)
        expect(claims.iss).toBe('TEAMID9999')
        expect(claims.iat).toBe(Math.floor(nowMs / 1000))
        expect(Object.keys(claims).sort()).toEqual(['iat', 'iss'])

        // Signature must verify against the matching public key.
        const verified = await jose.jwtVerify(token, await jose.importSPKI(
            publicKey.export({ type: 'spki', format: 'pem' }) as string,
            'ES256'
        ))
        expect(verified.payload.iss).toBe('TEAMID9999')
    })

    it('reuses the cached token below 45 minutes and regenerates after', async () => {
        const provider = new ApnsJwtProvider(TEST_KEY_P8, 'KEYID12345', 'TEAMID9999')
        const t0 = 1_700_000_000_000
        const first = await provider.getToken(t0)

        // 44 minutes later: cache hit, byte-identical token.
        expect(await provider.getToken(t0 + 44 * 60 * 1000)).toBe(first)

        // 46 minutes later: past the max age, fresh token with a new iat.
        const later = t0 + 46 * 60 * 1000
        const second = await provider.getToken(later)
        expect(second).not.toBe(first)
        expect(jose.decodeJwt(second).iat).toBe(Math.floor(later / 1000))
        expect(APNS_JWT_MAX_AGE_MS).toBe(45 * 60 * 1000)
    })
})

describe('buildApnsRequestBody', () => {
    it('carries the generic no-decrypt alert plus the hapi envelope', () => {
        expect(buildApnsRequestBody('ZW52')).toEqual({
            aps: {
                'mutable-content': 1,
                alert: { title: 'HAPI', body: 'New activity' },
                sound: 'default'
            },
            hapi: { v: 1, e: 'ZW52' }
        })
    })
})

/**
 * TRANSPORT VERIFICATION (Bun HTTP/2 client): these tests spin up a real
 * `node:http2` server and drive the real ApnsClient against it over the
 * actual Bun `node:http2` client stack - no mocks in the transport path.
 * If Bun's h2 client regresses, this suite fails loudly.
 */
describe('ApnsClient against a local node:http2 server', () => {
    type SeenRequest = {
        headers: http2.IncomingHttpHeaders
        body: string
    }
    let server: http2.Http2Server
    let baseUrl = ''
    const seen: SeenRequest[] = []
    // Per-token scripted responses.
    const responses = new Map<string, { status: number; body: string }>()

    beforeAll(async () => {
        server = http2.createServer()
        server.on('stream', (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
            const chunks: Buffer[] = []
            stream.on('data', (c: Buffer) => chunks.push(c))
            stream.on('end', () => {
                seen.push({ headers, body: Buffer.concat(chunks).toString('utf8') })
                const token = String(headers[':path'] ?? '').split('/').pop() ?? ''
                const scripted = responses.get(token) ?? { status: 200, body: '' }
                stream.respond({ ':status': scripted.status, 'apns-id': 'apns-id-1' })
                stream.end(scripted.body)
            })
        })
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
        const address = server.address()
        const port = typeof address === 'object' && address ? address.port : 0
        baseUrl = `http://127.0.0.1:${port}`
    })

    afterAll(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()))
    })

    function makeClient(): ApnsClient {
        return new ApnsClient({
            keyP8: TEST_KEY_P8,
            keyId: 'KEYID12345',
            teamId: 'TEAMID9999',
            bundleId: 'run.hapi.ios',
            host: baseUrl,
            requestTimeoutMs: 5000
        })
    }

    it('sends the spec-shaped APNs request (path, headers, body) and returns sent on 200', async () => {
        const client = makeClient()
        const outcome = await client.send({
            token: 'a1b2c3d4',
            envelope: 'RU5DUllQVEVE',
            collapseId: 'ready-sess-1',
            priority: 10
        })
        expect(outcome).toBe('sent')

        const request = seen[seen.length - 1]
        expect(request.headers[':method']).toBe('POST')
        expect(request.headers[':path']).toBe('/3/device/a1b2c3d4')
        expect(request.headers['apns-topic']).toBe('run.hapi.ios')
        expect(request.headers['apns-push-type']).toBe('alert')
        expect(request.headers['apns-priority']).toBe('10')
        expect(request.headers['apns-expiration']).toBe('0')
        expect(request.headers['apns-collapse-id']).toBe('ready-sess-1')
        expect(request.headers['content-type']).toBe('application/json')

        const authorization = String(request.headers['authorization'] ?? '')
        expect(authorization.startsWith('bearer ')).toBe(true)
        const jwt = authorization.slice('bearer '.length)
        expect(jose.decodeProtectedHeader(jwt)).toEqual({ alg: 'ES256', kid: 'KEYID12345' })
        expect(jose.decodeJwt(jwt).iss).toBe('TEAMID9999')

        expect(JSON.parse(request.body)).toEqual({
            aps: {
                'mutable-content': 1,
                alert: { title: 'HAPI', body: 'New activity' },
                sound: 'default'
            },
            hapi: { v: 1, e: 'RU5DUllQVEVE' }
        })
    })

    it('omits apns-collapse-id when no collapseId is given and defaults priority to 10', async () => {
        const client = makeClient()
        await client.send({ token: 'nocollapse', envelope: 'RU5D' })
        const request = seen[seen.length - 1]
        expect(request.headers['apns-collapse-id']).toBeUndefined()
        expect(request.headers['apns-priority']).toBe('10')
    })

    it('classifies 410 Unregistered as invalid (prune signal)', async () => {
        responses.set('gone410', { status: 410, body: '{"reason":"Unregistered","timestamp":1700000000000}' })
        const outcome = await makeClient().send({ token: 'gone410', envelope: 'RU5D' })
        expect(outcome).toBe('invalid')
    })

    it('classifies 400 BadDeviceToken as invalid (prune signal)', async () => {
        responses.set('bad400', { status: 400, body: '{"reason":"BadDeviceToken"}' })
        const outcome = await makeClient().send({ token: 'bad400', envelope: 'RU5D' })
        expect(outcome).toBe('invalid')
    })

    it('keeps the device on other 400s (e.g. BadCollapseId) - transient, not token death', async () => {
        responses.set('collapse400', { status: 400, body: '{"reason":"BadCollapseId"}' })
        const outcome = await makeClient().send({ token: 'collapse400', envelope: 'RU5D' })
        expect(outcome).toBe('failed')
    })

    it('treats 403 (auth problem) and 5xx as transient failures', async () => {
        responses.set('auth403', { status: 403, body: '{"reason":"InvalidProviderToken"}' })
        responses.set('boom503', { status: 503, body: '{"reason":"ServiceUnavailable"}' })
        expect(await makeClient().send({ token: 'auth403', envelope: 'RU5D' })).toBe('failed')
        expect(await makeClient().send({ token: 'boom503', envelope: 'RU5D' })).toBe('failed')
    })

    it('treats 429 TooManyRequests as transient', async () => {
        responses.set('rate429', { status: 429, body: '{"reason":"TooManyRequests"}' })
        expect(await makeClient().send({ token: 'rate429', envelope: 'RU5D' })).toBe('failed')
    })

    it('reuses the JWT across sends within the cache window', async () => {
        const client = makeClient()
        await client.send({ token: 'jwt1', envelope: 'RU5D' })
        await client.send({ token: 'jwt2', envelope: 'RU5D' })
        const [first, second] = seen.slice(-2)
        expect(first.headers['authorization']).toBe(second.headers['authorization'])
    })
})

describe('ApnsClient connection failure', () => {
    it('returns failed (not invalid) when the host is unreachable', async () => {
        const client = new ApnsClient({
            keyP8: TEST_KEY_P8,
            keyId: 'KEYID12345',
            teamId: 'TEAMID9999',
            bundleId: 'run.hapi.ios',
            // Reserved TEST-NET-1 address: connection refused / no route.
            host: 'http://127.0.0.1:1',
            requestTimeoutMs: 3000
        })
        expect(await client.send({ token: 'unreachable', envelope: 'RU5D' })).toBe('failed')
    })

    it('returns failed on a broken .p8 key without touching the network', async () => {
        const client = new ApnsClient({
            keyP8: 'not-a-pem',
            keyId: 'K',
            teamId: 'T',
            bundleId: 'run.hapi.ios',
            host: 'http://127.0.0.1:1'
        })
        expect(await client.send({ token: 'x', envelope: 'RU5D' })).toBe('failed')
    })
})
