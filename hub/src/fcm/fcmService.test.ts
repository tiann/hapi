import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { FcmService, type FcmSendPayload } from './fcmService'

mock.module('./fcmAuth', () => ({
    getFcmAccessToken: async () => 'test-access-token',
    loadServiceAccount: () => ({ client_email: 'x', private_key: 'y' })
}))

type FakeStore = {
    fcm: {
        getDevicesByNamespace: ReturnType<typeof mock>
        removeDeviceByToken: ReturnType<typeof mock>
    }
}

function makeStore(devices: Array<{ token: string; platform: 'phone' | 'wear'; deviceId: string; namespace: string }>): FakeStore {
    return {
        fcm: {
            getDevicesByNamespace: mock((ns: string) =>
                devices
                    .filter(d => d.namespace === ns)
                    .map(d => ({
                        id: 0,
                        namespace: d.namespace,
                        token: d.token,
                        platform: d.platform,
                        deviceId: d.deviceId,
                        createdAt: 0,
                        updatedAt: 0
                    }))
            ),
            removeDeviceByToken: mock(() => {})
        }
    }
}

function makePayload(overrides: Partial<FcmSendPayload['data']> = {}): FcmSendPayload {
    return {
        title: 'T',
        body: 'B',
        data: {
            type: 'ready',
            sessionId: 'sess-1',
            sessionName: 'Demo',
            url: 'https://hapi.example.com/sessions/sess-1',
            title: 'T',
            body: 'B',
            contractVersion: '1',
            ...overrides
        }
    }
}

describe('FcmService.sendToNamespace', () => {
    let originalFetch: typeof globalThis.fetch
    beforeEach(() => {
        originalFetch = globalThis.fetch
    })
    afterEach(() => {
        globalThis.fetch = originalFetch
    })

    it('removes the device row when FCM returns 404 UNREGISTERED (token rotated)', async () => {
        const store = makeStore([
            { namespace: 'default', token: 'rotated-token', platform: 'phone', deviceId: 'p1' }
        ])
        globalThis.fetch = mock(async () =>
            new Response('{"error":{"status":"UNREGISTERED"}}', { status: 404 })
        ) as unknown as typeof fetch

        const svc = new FcmService('proj-id', { client_email: 'x', private_key: 'y' }, store as never)
        const result = await svc.sendToNamespace('default', makePayload())

        expect(result.sent).toBe(0)
        expect(result.failed).toBe(1)
        expect(result.invalidTokens).toEqual(['rotated-token'])
        expect(store.fcm.removeDeviceByToken).toHaveBeenCalledWith('default', 'rotated-token')
    })

    it('keeps the device row on generic 404 NOT_FOUND (bad project/resource config)', async () => {
        const store = makeStore([
            { namespace: 'default', token: 'live-token', platform: 'phone', deviceId: 'p1' }
        ])
        globalThis.fetch = mock(async () =>
            new Response('{"error":{"status":"NOT_FOUND","message":"Requested entity was not found."}}', { status: 404 })
        ) as unknown as typeof fetch

        const svc = new FcmService('proj-id', { client_email: 'x', private_key: 'y' }, store as never)
        const result = await svc.sendToNamespace('default', makePayload())

        expect(result.failed).toBe(1)
        expect(result.invalidTokens).toEqual([])
        expect(store.fcm.removeDeviceByToken).not.toHaveBeenCalled()
    })

    it('removes the device row on canonical 404 NOT_FOUND + FcmError UNREGISTERED', async () => {
        const store = makeStore([
            { namespace: 'default', token: 'dead-token', platform: 'phone', deviceId: 'p1' }
        ])
        globalThis.fetch = mock(async () =>
            new Response(JSON.stringify({
                error: {
                    status: 'NOT_FOUND',
                    details: [{
                        '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
                        errorCode: 'UNREGISTERED'
                    }]
                }
            }), { status: 404 })
        ) as unknown as typeof fetch

        const svc = new FcmService('proj-id', { client_email: 'x', private_key: 'y' }, store as never)
        const result = await svc.sendToNamespace('default', makePayload())

        expect(result.invalidTokens).toEqual(['dead-token'])
        expect(store.fcm.removeDeviceByToken).toHaveBeenCalledWith('default', 'dead-token')
    })

    it('keeps the device row on 400 INVALID_ARGUMENT without token field violation', async () => {
        const store = makeStore([
            { namespace: 'default', token: 'live-token', platform: 'phone', deviceId: 'p1' }
        ])
        globalThis.fetch = mock(async () =>
            new Response(JSON.stringify({
                error: {
                    status: 'INVALID_ARGUMENT',
                    details: [{
                        fieldViolations: [{ field: 'message.data.body', description: 'too long' }]
                    }]
                }
            }), { status: 400 })
        ) as unknown as typeof fetch

        const svc = new FcmService('proj-id', { client_email: 'x', private_key: 'y' }, store as never)
        const result = await svc.sendToNamespace('default', makePayload())

        expect(result.failed).toBe(1)
        expect(store.fcm.removeDeviceByToken).not.toHaveBeenCalled()
    })

    it('keeps the device row on transient 429 (rate limit) - regression for HAPI Bot finding', async () => {
        const store = makeStore([
            { namespace: 'default', token: 'rate-limited-token', platform: 'phone', deviceId: 'p1' }
        ])
        globalThis.fetch = mock(async () =>
            new Response('{"error":{"status":"RESOURCE_EXHAUSTED"}}', { status: 429 })
        ) as unknown as typeof fetch

        const svc = new FcmService('proj-id', { client_email: 'x', private_key: 'y' }, store as never)
        const result = await svc.sendToNamespace('default', makePayload())

        expect(result.sent).toBe(0)
        expect(result.failed).toBe(1)
        expect(result.invalidTokens).toEqual([])
        // Critical: must NOT remove the device on a transient failure.
        expect(store.fcm.removeDeviceByToken).not.toHaveBeenCalled()
    })

    it('keeps the device row on transient 503 (server error)', async () => {
        const store = makeStore([
            { namespace: 'default', token: 'live-token', platform: 'wear', deviceId: 'w1' }
        ])
        globalThis.fetch = mock(async () =>
            new Response('Service Unavailable', { status: 503 })
        ) as unknown as typeof fetch

        const svc = new FcmService('proj-id', { client_email: 'x', private_key: 'y' }, store as never)
        const result = await svc.sendToNamespace('default', makePayload())

        expect(result.failed).toBe(1)
        expect(result.invalidTokens).toEqual([])
        expect(store.fcm.removeDeviceByToken).not.toHaveBeenCalled()
    })

    it('keeps the device row on 401 auth glitch (our problem, not the device\'s)', async () => {
        const store = makeStore([
            { namespace: 'default', token: 'live-token', platform: 'phone', deviceId: 'p1' }
        ])
        globalThis.fetch = mock(async () =>
            new Response('{"error":{"status":"UNAUTHENTICATED"}}', { status: 401 })
        ) as unknown as typeof fetch

        const svc = new FcmService('proj-id', { client_email: 'x', private_key: 'y' }, store as never)
        const result = await svc.sendToNamespace('default', makePayload())

        expect(result.failed).toBe(1)
        expect(store.fcm.removeDeviceByToken).not.toHaveBeenCalled()
    })

    it('keeps the device row when fetch itself throws (network error)', async () => {
        const store = makeStore([
            { namespace: 'default', token: 'live-token', platform: 'phone', deviceId: 'p1' }
        ])
        globalThis.fetch = mock(async () => {
            throw new Error('ECONNREFUSED')
        }) as unknown as typeof fetch

        const svc = new FcmService('proj-id', { client_email: 'x', private_key: 'y' }, store as never)
        const result = await svc.sendToNamespace('default', makePayload())

        expect(result.failed).toBe(1)
        expect(store.fcm.removeDeviceByToken).not.toHaveBeenCalled()
    })

    it('treats timed-out FCM send as transient failure', async () => {
        const store = makeStore([
            { namespace: 'default', token: 'live-token', platform: 'phone', deviceId: 'p1' }
        ])
        globalThis.fetch = mock(async (_url, init) => {
            expect(init?.signal).toBeDefined()
            throw new DOMException('The operation was aborted.', 'AbortError')
        }) as unknown as typeof fetch

        const svc = new FcmService('proj-id', { client_email: 'x', private_key: 'y' }, store as never)
        const result = await svc.sendToNamespace('default', makePayload())

        expect(result.failed).toBe(1)
        expect(store.fcm.removeDeviceByToken).not.toHaveBeenCalled()
    })

    it('counts a 200 response as sent', async () => {
        const store = makeStore([
            { namespace: 'default', token: 'live-token', platform: 'phone', deviceId: 'p1' }
        ])
        globalThis.fetch = mock(async () =>
            new Response('{"name":"projects/proj-id/messages/0:1234567890"}', { status: 200 })
        ) as unknown as typeof fetch

        const svc = new FcmService('proj-id', { client_email: 'x', private_key: 'y' }, store as never)
        const result = await svc.sendToNamespace('default', makePayload())

        expect(result.sent).toBe(1)
        expect(result.failed).toBe(0)
        expect(store.fcm.removeDeviceByToken).not.toHaveBeenCalled()
    })

    it('mixed batch: removes invalid token, keeps device with transient failure, counts good send', async () => {
        const store = makeStore([
            { namespace: 'default', token: 'good-token', platform: 'phone', deviceId: 'p1' },
            { namespace: 'default', token: 'rotated-token', platform: 'phone', deviceId: 'p2' },
            { namespace: 'default', token: 'rate-limited-token', platform: 'wear', deviceId: 'w1' }
        ])

        const responseFor: Record<string, () => Response> = {
            'good-token': () => new Response('{"name":"ok"}', { status: 200 }),
            'rotated-token': () => new Response('{"error":{"status":"UNREGISTERED"}}', { status: 404 }),
            'rate-limited-token': () => new Response('{"error":{"status":"RESOURCE_EXHAUSTED"}}', { status: 429 })
        }
        globalThis.fetch = mock(async (_url: unknown, init?: RequestInit) => {
            const body = JSON.parse((init?.body as string) ?? '{}') as { message?: { token?: string } }
            const token = body.message?.token ?? ''
            const fn = responseFor[token]
            return fn ? fn() : new Response('unknown', { status: 500 })
        }) as unknown as typeof fetch

        const svc = new FcmService('proj-id', { client_email: 'x', private_key: 'y' }, store as never)
        const result = await svc.sendToNamespace('default', makePayload())

        expect(result.sent).toBe(1)
        expect(result.failed).toBe(2)
        expect(result.invalidTokens).toEqual(['rotated-token'])
        // Only the truly-rotated token gets unregistered. The rate-limited
        // device must survive to be retried on the next notification.
        expect(store.fcm.removeDeviceByToken).toHaveBeenCalledTimes(1)
        expect(store.fcm.removeDeviceByToken).toHaveBeenCalledWith('default', 'rotated-token')
    })

    it('returns zero counts when namespace has no devices', async () => {
        const store = makeStore([])
        globalThis.fetch = mock(async () => new Response('should-not-be-called', { status: 200 })) as unknown as typeof fetch

        const svc = new FcmService('proj-id', { client_email: 'x', private_key: 'y' }, store as never)
        const result = await svc.sendToNamespace('empty-ns', makePayload())

        expect(result).toEqual({ sent: 0, failed: 0, invalidTokens: [] })
        expect(globalThis.fetch).not.toHaveBeenCalled()
    })
})

describe('FcmService.isHealthy (rolling outcome window)', () => {
    let originalFetch: typeof globalThis.fetch
    beforeEach(() => {
        originalFetch = globalThis.fetch
    })
    afterEach(() => {
        globalThis.fetch = originalFetch
    })

    it('starts UNHEALTHY with an empty outcome buffer (no positive evidence yet)', () => {
        // Cold-start invariant (HAPI Bot Major fix on PR #803): the gate
        // requires at least one observed success before suppressing
        // web-push. Otherwise a hub started with broken FCM credentials
        // silently drops the first N notifications while waiting for the
        // failure threshold to trip.
        const store = makeStore([])
        const svc = new FcmService('proj-id', { client_email: 'x', private_key: 'y' }, store as never)
        expect(svc.isHealthy()).toBe(false)
    })

    it('flips to healthy after the first successful send', async () => {
        const store = makeStore([
            { namespace: 'default', token: 't1', platform: 'phone', deviceId: 'p1' }
        ])
        globalThis.fetch = mock(async () =>
            new Response('{"name":"ok"}', { status: 200 })
        ) as unknown as typeof fetch

        const svc = new FcmService('proj-id', { client_email: 'x', private_key: 'y' }, store as never)
        expect(svc.isHealthy()).toBe(false)
        await svc.sendToNamespace('default', makePayload())
        expect(svc.isHealthy()).toBe(true)
    })

    it('stays unhealthy across a run of failures with no successes (broken-FCM cold start)', async () => {
        const store = makeStore([
            { namespace: 'default', token: 't1', platform: 'phone', deviceId: 'p1' }
        ])
        globalThis.fetch = mock(async () =>
            new Response('Service Unavailable', { status: 503 })
        ) as unknown as typeof fetch

        const svc = new FcmService('proj-id', { client_email: 'x', private_key: 'y' }, store as never)

        // Without any prior success the gate must stay unhealthy regardless
        // of where we are in the failure-threshold count. This is the exact
        // silent-blackhole window the bot flagged.
        for (let i = 0; i < 5; i += 1) {
            await svc.sendToNamespace('default', makePayload())
            expect(svc.isHealthy()).toBe(false)
        }
    })

    it('flips back to unhealthy when failures stack past threshold after prior successes', async () => {
        const store = makeStore([
            { namespace: 'default', token: 't1', platform: 'phone', deviceId: 'p1' }
        ])
        let callCount = 0
        globalThis.fetch = mock(async () => {
            callCount += 1
            // First 3 succeed, then 503s
            if (callCount <= 3) return new Response('{"name":"ok"}', { status: 200 })
            return new Response('Service Unavailable', { status: 503 })
        }) as unknown as typeof fetch

        const svc = new FcmService('proj-id', { client_email: 'x', private_key: 'y' }, store as never)

        // 3 successes establish health
        for (let i = 0; i < 3; i += 1) await svc.sendToNamespace('default', makePayload())
        expect(svc.isHealthy()).toBe(true)

        // 4 failures: window is [S,S,S,F,F,F,F] - 4 < 5 -> still healthy
        for (let i = 0; i < 4; i += 1) await svc.sendToNamespace('default', makePayload())
        expect(svc.isHealthy()).toBe(true)

        // 5th failure: [S,S,S,F,F,F,F,F] - 5 >= 5 -> unhealthy
        await svc.sendToNamespace('default', makePayload())
        expect(svc.isHealthy()).toBe(false)
    })

    it('recovers to healthy as recent successes age out the failure tail', async () => {
        const store = makeStore([
            { namespace: 'default', token: 't1', platform: 'phone', deviceId: 'p1' }
        ])
        let callCount = 0
        globalThis.fetch = mock(async () => {
            callCount += 1
            // First 5 calls fail (503), rest succeed
            if (callCount <= 5) {
                return new Response('Service Unavailable', { status: 503 })
            }
            return new Response('{"name":"ok"}', { status: 200 })
        }) as unknown as typeof fetch

        const svc = new FcmService('proj-id', { client_email: 'x', private_key: 'y' }, store as never)

        for (let i = 0; i < 5; i += 1) {
            await svc.sendToNamespace('default', makePayload())
        }
        expect(svc.isHealthy()).toBe(false)

        // 4 successes after 5 failures: window is [F,F,F,F,F,S,S,S,S] -> trim
        // to last 8: [F,F,F,F,S,S,S,S] -> 4 failures, threshold 5 -> healthy.
        for (let i = 0; i < 4; i += 1) {
            await svc.sendToNamespace('default', makePayload())
        }
        expect(svc.isHealthy()).toBe(true)
    })

    it('does NOT count invalid-token responses against health (per-device fact, not pipeline failure)', async () => {
        const store = makeStore([
            { namespace: 'default', token: 'good', platform: 'phone', deviceId: 'p1' },
            { namespace: 'default', token: 'rotated', platform: 'phone', deviceId: 'p2' }
        ])
        globalThis.fetch = mock(async (url: unknown, init?: unknown) => {
            // Different responses per device token. We use the request
            // body to discriminate - both calls go to the same URL.
            const body = JSON.parse(((init as { body?: string })?.body) ?? '{}')
            const token = body?.message?.token
            if (token === 'good') return new Response('{"name":"ok"}', { status: 200 })
            return new Response('{"error":{"status":"UNREGISTERED"}}', { status: 404 })
        }) as unknown as typeof fetch

        const svc = new FcmService('proj-id', { client_email: 'x', private_key: 'y' }, store as never)

        // First send produces 1 sent + 1 invalid. After this the rotated
        // token is removed from the store, leaving only the good one.
        await svc.sendToNamespace('default', makePayload())
        expect(svc.isHealthy()).toBe(true)

        // Subsequent successful sends do not record additional outcomes
        // for the (now-pruned) invalid token. Health stays true.
        for (let i = 0; i < 10; i += 1) {
            await svc.sendToNamespace('default', makePayload())
        }
        expect(svc.isHealthy()).toBe(true)
    })

    it('counts fetch-throw (network error) as a health failure', async () => {
        const store = makeStore([
            { namespace: 'default', token: 't1', platform: 'phone', deviceId: 'p1' }
        ])
        let callCount = 0
        globalThis.fetch = mock(async () => {
            callCount += 1
            // First few succeed (establish health), rest throw network error
            if (callCount <= 3) return new Response('{"name":"ok"}', { status: 200 })
            throw new Error('ECONNREFUSED')
        }) as unknown as typeof fetch

        const svc = new FcmService('proj-id', { client_email: 'x', private_key: 'y' }, store as never)

        // Establish health with 3 successes
        for (let i = 0; i < 3; i += 1) await svc.sendToNamespace('default', makePayload())
        expect(svc.isHealthy()).toBe(true)

        // 5 network errors stack past threshold and flip health
        for (let i = 0; i < 5; i += 1) await svc.sendToNamespace('default', makePayload())
        expect(svc.isHealthy()).toBe(false)
    })
})
