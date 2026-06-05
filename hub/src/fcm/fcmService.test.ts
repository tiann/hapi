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
