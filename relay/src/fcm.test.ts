import { beforeAll, describe, expect, test } from 'bun:test'
import { exportPKCS8, generateKeyPair, jwtVerify } from 'jose'
import { FcmAccessTokenProvider, HttpFcmClient, isInvalidFcmToken, parseServiceAccount, type FcmFetch } from './fcm'
import { createRelayApp } from './index'
import { TokenBucketLimiter } from './rateLimit'
import { IP_RATE_LIMIT, TOKEN_RATE_LIMIT } from './config'

let account: ReturnType<typeof parseServiceAccount>
let publicKey: CryptoKey
beforeAll(async () => {
    const pair = await generateKeyPair('RS256', { extractable: true })
    publicKey = pair.publicKey
    account = { project_id: 'official-project', client_email: 'sender@example.com', private_key: await exportPKCS8(pair.privateKey) }
})

test('rejects incomplete credentials without echoing their contents', () => {
    for (const value of [null, [], {}, { project_id: 1 }, { project_id: 'p', client_email: 'e', private_key: '' }]) {
        expect(() => parseServiceAccount(value)).toThrow('FCM service account requires')
    }
})

describe('FCM OAuth cache', () => {
    test('signs the correct grant, shares concurrent exchanges, and refreshes before expiry', async () => {
        let now = Date.now()
        let exchanges = 0
        const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
            expect(String(url)).toBe('https://oauth2.googleapis.com/token')
            const form = new URLSearchParams(String(init?.body))
            expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
            const { payload } = await jwtVerify(form.get('assertion')!, publicKey, { currentDate: new Date(now) })
            expect(payload.iss).toBe(account.client_email)
            expect(payload.sub).toBe(account.client_email)
            expect(payload.aud).toBe('https://oauth2.googleapis.com/token')
            expect(payload.scope).toBe('https://www.googleapis.com/auth/firebase.messaging')
            exchanges += 1
            return Response.json({ access_token: `access-${exchanges}`, expires_in: 3600 })
        }) as FcmFetch
        const auth = await FcmAccessTokenProvider.create(account, { now: () => now, fetcher })
        expect(await Promise.all(Array.from({ length: 12 }, () => auth.getAccessToken()))).toEqual(Array(12).fill('access-1'))
        now += 3500_000
        expect(await auth.getAccessToken()).toBe('access-1')
        now += 50_000
        expect(await Promise.all([auth.getAccessToken(), auth.getAccessToken()])).toEqual(['access-2', 'access-2'])
        expect(exchanges).toBe(2)
    })

    test('clears a failed exchange so a later request can recover', async () => {
        let failures = true
        const auth = await FcmAccessTokenProvider.create(account, { fetcher: (async () => failures
            ? new Response('private upstream details', { status: 500 })
            : Response.json({ access_token: 'recovered', expires_in: 3600 })) as FcmFetch })
        await expect(auth.getAccessToken()).rejects.toThrow('FCM OAuth exchange failed')
        failures = false
        expect(await auth.getAccessToken()).toBe('recovered')
    })
})

const fcmError = (code: string, message?: string) => ({ error: {
    status: code === 'UNREGISTERED' ? 'NOT_FOUND' : code,
    message,
    details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: code }]
} })

test.each([
    [404, fcmError('UNREGISTERED'), true],
    [404, { error: { status: 'NOT_FOUND' } }, false],
    [403, fcmError('SENDER_ID_MISMATCH'), false],
    [400, fcmError('INVALID_ARGUMENT'), false],
    [400, fcmError('INVALID_ARGUMENT', 'Message too big'), false],
    [400, fcmError('INVALID_ARGUMENT', 'The registration token is not a valid FCM registration token'), true],
    [400, { error: { status: 'INVALID_ARGUMENT', details: [{ fieldViolations: [{ field: 'message.token' }] }] } }, true],
    [400, { error: { status: 'INVALID_ARGUMENT', details: [{ fieldViolations: [{ field: 'message.data.token' }] }] } }, false],
    [400, { error: { status: 'INVALID_ARGUMENT', details: [{ fieldViolations: [{ field: 'message.token' }, { field: 'message.data' }] }] } }, false],
    [400, { error: { details: [null, 42] } }, false]
] as const)('classifies only confirmed dead tokens (HTTP %i)', (status, body, invalid) => {
    expect(isInvalidFcmToken(status, body)).toBe(invalid)
})

describe('relay to FCM integration', () => {
    test('forwards the exact ciphertext, preserves token case, and never sends display/collapse fields', async () => {
        const token = 'AbC:Mixed-case_123'
        const envelope = Buffer.from('encrypted notification bytes').toString('base64')
        const requests: Array<{ url: string; body: unknown }> = []
        const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
            if (String(url).includes('oauth2')) return Response.json({ access_token: 'access', expires_in: 3600 })
            expect(new Headers(init?.headers).get('authorization')).toBe('Bearer access')
            requests.push({ url: String(url), body: JSON.parse(String(init?.body)) as unknown })
            return Response.json({ name: 'projects/official-project/messages/1' })
        }) as FcmFetch
        const auth = await FcmAccessTokenProvider.create(account, { fetcher })
        const logs: string[] = []
        const app = createRelayApp({
            fcm: new HttpFcmClient(account.project_id, 'run.hapi.companion', auth, fetcher), version: 'test',
            ipLimiter: new TokenBucketLimiter(IP_RATE_LIMIT), tokenLimiter: new TokenBucketLimiter(TOKEN_RATE_LIMIT),
            log: line => logs.push(line)
        })
        for (const priority of [10, 5]) {
            const response = await app.handle(new Request('https://relay/v1/push', { method: 'POST',
                body: JSON.stringify({ platform: 'android', token, envelope, priority, collapseId: 'do-not-forward' }) }), 'ip')
            expect(response.status).toBe(200)
        }
        expect(requests).toEqual([10, 5].map(priority => ({
            url: 'https://fcm.googleapis.com/v1/projects/official-project/messages:send',
            body: { message: { token, data: { hapi_v: '1', hapi_e: envelope }, android: {
                priority: priority === 10 ? 'HIGH' : 'NORMAL', restricted_package_name: 'run.hapi.companion'
            } } }
        })))
        expect(logs.join('\n')).toContain('platform=android')
        for (const secret of [token, envelope, 'access', account.private_key]) expect(logs.join('\n')).not.toContain(secret)
    })

    test.each([
        [404, fcmError('UNREGISTERED'), 410],
        [400, fcmError('INVALID_ARGUMENT'), 502],
        [403, fcmError('SENDER_ID_MISMATCH'), 502],
        [401, { error: 'bad credentials' }, 502],
        [429, {}, 429],
        [503, {}, 502]
    ] as const)('maps FCM HTTP %i without losing registration on pipeline failures', async (status, body, expected) => {
        let invalidations = 0
        const fcm = new HttpFcmClient('p', 'run.hapi.companion', {
            async getAccessToken() { return 'access' }, invalidate() { invalidations += 1 }
        }, (async () => Response.json(body, { status })) as FcmFetch)
        const app = createRelayApp({ fcm, version: 'test', log: () => {},
            ipLimiter: new TokenBucketLimiter(IP_RATE_LIMIT), tokenLimiter: new TokenBucketLimiter(TOKEN_RATE_LIMIT) })
        const response = await app.handle(new Request('https://relay/v1/push', { method: 'POST',
            body: JSON.stringify({ platform: 'android', token: 'opaque-token', envelope: 'QUJDRA==' }) }), 'ip')
        expect(response.status).toBe(expected)
        expect(invalidations).toBe(status === 401 ? 1 : 0)
    })

    test('treats timeouts and OAuth failures as upstream failures', async () => {
        const failingAuth = { async getAccessToken(): Promise<string> { throw new Error('private detail') }, invalidate() {} }
        expect(await new HttpFcmClient('p', 'p.app', failingAuth).push({ token: 't', envelope: 'e', priority: 10 }))
            .toEqual({ kind: 'upstream' })
        const fetcher = ((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('timeout')), { once: true })
        })) as FcmFetch
        const fcm = new HttpFcmClient('p', 'p.app', { async getAccessToken() { return 'a' }, invalidate() {} }, fetcher, 20)
        expect(await fcm.push({ token: 't', envelope: 'e', priority: 10 })).toEqual({ kind: 'upstream' })
    })
})
