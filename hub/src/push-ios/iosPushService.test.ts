import { describe, expect, it } from 'bun:test'
import { randomBytes } from 'node:crypto'

import { Store } from '../store'
import { canonicalJson, decryptEnvelope } from './envelope'
import { IosPushService, buildCollapseId, type IosPushNotificationPayload } from './iosPushService'
import type { IosPushRequest, IosPushSendOutcome, IosPushTransport } from './transport'

function makePayload(overrides: Partial<IosPushNotificationPayload> = {}): IosPushNotificationPayload {
    return {
        type: 'ready',
        sessionId: 's1',
        sessionName: 'Demo',
        url: '/sessions/s1',
        title: 'HAPI',
        body: 'Ready for input',
        severity: 'info',
        contractVersion: '1',
        ...overrides
    }
}

type ScriptedTransport = IosPushTransport & { requests: IosPushRequest[] }

function makeTransport(outcomeFor: (request: IosPushRequest) => IosPushSendOutcome): ScriptedTransport {
    const requests: IosPushRequest[] = []
    return {
        requests,
        async send(request: IosPushRequest) {
            requests.push(request)
            return outcomeFor(request)
        }
    }
}

function registerIosDevice(store: Store, namespace: string, token: string, deviceId: string): Buffer {
    const key = randomBytes(32)
    store.fcm.upsertDevice(namespace, {
        token,
        platform: 'ios',
        deviceId,
        pushKey: key.toString('base64')
    })
    return key
}

describe('IosPushService.sendToNamespace', () => {
    it('encrypts the canonical payload per device key and sends with collapse id + priority 10', async () => {
        const store = new Store(':memory:')
        const key = registerIosDevice(store, 'default', 'tok-1', 'iphone-1')
        const transport = makeTransport(() => 'sent')
        const service = new IosPushService(transport, store)

        const payload = makePayload({ requestId: 'req-7', type: 'permission-request' })
        const result = await service.sendToNamespace('default', payload)

        expect(result).toEqual({ sent: 1, failed: 0, invalidTokens: [] })
        expect(transport.requests).toHaveLength(1)
        const request = transport.requests[0]
        expect(request.token).toBe('tok-1')
        expect(request.collapseId).toBe('permission-request-s1')
        expect(request.priority).toBe(10)

        // The envelope decrypts (only) under this device's key, to the
        // canonical-JSON serialization of the payload.
        const plaintext = decryptEnvelope(key, request.envelope)
        expect(plaintext).toBe(canonicalJson(payload))
        expect(JSON.parse(plaintext)).toEqual({
            body: 'Ready for input',
            contractVersion: '1',
            requestId: 'req-7',
            sessionId: 's1',
            sessionName: 'Demo',
            severity: 'info',
            title: 'HAPI',
            type: 'permission-request',
            url: '/sessions/s1'
        })
    })

    it('each device gets an envelope only its own key can open', async () => {
        const store = new Store(':memory:')
        const keyA = registerIosDevice(store, 'default', 'tok-a', 'iphone-a')
        const keyB = registerIosDevice(store, 'default', 'tok-b', 'iphone-b')
        const transport = makeTransport(() => 'sent')
        const service = new IosPushService(transport, store)

        await service.sendToNamespace('default', makePayload())

        expect(transport.requests).toHaveLength(2)
        const byToken = new Map(transport.requests.map((r) => [r.token, r.envelope]))
        expect(decryptEnvelope(keyA, byToken.get('tok-a')!)).toBe(canonicalJson(makePayload()))
        expect(decryptEnvelope(keyB, byToken.get('tok-b')!)).toBe(canonicalJson(makePayload()))
        expect(() => decryptEnvelope(keyA, byToken.get('tok-b')!)).toThrow()
        expect(() => decryptEnvelope(keyB, byToken.get('tok-a')!)).toThrow()
    })

    it('prunes the device row on invalid outcome and keeps it on failed', async () => {
        const store = new Store(':memory:')
        registerIosDevice(store, 'default', 'dead-token', 'iphone-dead')
        registerIosDevice(store, 'default', 'flaky-token', 'iphone-flaky')
        const transport = makeTransport((request) =>
            request.token === 'dead-token' ? 'invalid' : 'failed'
        )
        const service = new IosPushService(transport, store)

        const result = await service.sendToNamespace('default', makePayload())

        expect(result.sent).toBe(0)
        expect(result.failed).toBe(2)
        expect(result.invalidTokens).toEqual(['dead-token'])
        const remaining = store.fcm.getDevicesByNamespace('default', ['ios'])
        expect(remaining).toHaveLength(1)
        expect(remaining[0].token).toBe('flaky-token')
    })

    it('returns zero counts and skips the transport when the namespace has no ios devices', async () => {
        const store = new Store(':memory:')
        // Android rows must not leak into the iOS pipeline.
        store.fcm.upsertDevice('default', { token: 'fcm-tok', platform: 'phone', deviceId: 'pixel-1' })
        const transport = makeTransport(() => 'sent')
        const service = new IosPushService(transport, store)

        const result = await service.sendToNamespace('default', makePayload())

        expect(result).toEqual({ sent: 0, failed: 0, invalidTokens: [] })
        expect(transport.requests).toHaveLength(0)
    })

    it('prunes a row whose stored pushKey is corrupt without calling the transport', async () => {
        const store = new Store(':memory:')
        // Store layer accepts what it is given; the route normally validates.
        store.fcm.upsertDevice('default', {
            token: 'corrupt-token',
            platform: 'ios',
            deviceId: 'iphone-corrupt',
            pushKey: Buffer.from('too-short').toString('base64')
        })
        const transport = makeTransport(() => 'sent')
        const service = new IosPushService(transport, store)

        const result = await service.sendToNamespace('default', makePayload())

        expect(result.invalidTokens).toEqual(['corrupt-token'])
        expect(transport.requests).toHaveLength(0)
        expect(store.fcm.getDevicesByNamespace('default', ['ios'])).toHaveLength(0)
    })

    it('treats a transport throw as transient failure (device kept)', async () => {
        const store = new Store(':memory:')
        registerIosDevice(store, 'default', 'tok-1', 'iphone-1')
        const transport: IosPushTransport = {
            async send() {
                throw new Error('boom')
            }
        }
        const service = new IosPushService(transport, store)

        const result = await service.sendToNamespace('default', makePayload())

        expect(result).toEqual({ sent: 0, failed: 1, invalidTokens: [] })
        expect(store.fcm.getDevicesByNamespace('default', ['ios'])).toHaveLength(1)
    })

    it('drops undefined optional fields from the encrypted plaintext', async () => {
        const store = new Store(':memory:')
        const key = registerIosDevice(store, 'default', 'tok-1', 'iphone-1')
        const transport = makeTransport(() => 'sent')
        const service = new IosPushService(transport, store)

        await service.sendToNamespace('default', {
            type: 'ready',
            sessionId: 's1',
            title: 'HAPI',
            body: 'Ready for input',
            contractVersion: '1'
        })

        const plaintext = decryptEnvelope(key, transport.requests[0].envelope)
        expect(plaintext).toBe('{"body":"Ready for input","contractVersion":"1","sessionId":"s1","title":"HAPI","type":"ready"}')
    })
})

describe('buildCollapseId', () => {
    it('joins type and sessionId', () => {
        expect(buildCollapseId('ready', 's1')).toBe('ready-s1')
    })

    it('truncates to 64 bytes', () => {
        const longSession = 'x'.repeat(100)
        const collapseId = buildCollapseId('permission-request', longSession)
        expect(Buffer.byteLength(collapseId, 'utf8')).toBe(64)
        expect(collapseId.startsWith('permission-request-xxx')).toBe(true)
    })

    it('truncates on a UTF-8 character boundary', () => {
        // Each CJK char is 3 bytes; 64 is not a multiple of 3 after the
        // ASCII prefix, so naive byte slicing would split a character.
        const collapseId = buildCollapseId('ready', '会'.repeat(40))
        expect(Buffer.byteLength(collapseId, 'utf8')).toBeLessThanOrEqual(64)
        // Re-encoding must be lossless (no replacement chars).
        expect(Buffer.from(collapseId, 'utf8').toString('utf8')).toBe(collapseId)
        expect(collapseId.includes('�')).toBe(false)
    })
})

describe('IosPushService.isHealthy (rolling outcome window)', () => {
    it('starts UNHEALTHY with an empty outcome buffer (positive evidence required)', () => {
        const store = new Store(':memory:')
        const service = new IosPushService(makeTransport(() => 'sent'), store)
        expect(service.isHealthy()).toBe(false)
    })

    it('flips to healthy after the first successful send', async () => {
        const store = new Store(':memory:')
        registerIosDevice(store, 'default', 'tok-1', 'iphone-1')
        const service = new IosPushService(makeTransport(() => 'sent'), store)
        expect(service.isHealthy()).toBe(false)
        await service.sendToNamespace('default', makePayload())
        expect(service.isHealthy()).toBe(true)
    })

    it('stays unhealthy across failures with no successes (broken transport cold start)', async () => {
        const store = new Store(':memory:')
        registerIosDevice(store, 'default', 'tok-1', 'iphone-1')
        const service = new IosPushService(makeTransport(() => 'failed'), store)
        for (let i = 0; i < 5; i += 1) {
            await service.sendToNamespace('default', makePayload())
            expect(service.isHealthy()).toBe(false)
        }
    })

    it('flips back to unhealthy when failures stack past threshold after prior successes', async () => {
        const store = new Store(':memory:')
        registerIosDevice(store, 'default', 'tok-1', 'iphone-1')
        let callCount = 0
        const service = new IosPushService(makeTransport(() => {
            callCount += 1
            return callCount <= 3 ? 'sent' : 'failed'
        }), store)

        for (let i = 0; i < 3; i += 1) await service.sendToNamespace('default', makePayload())
        expect(service.isHealthy()).toBe(true)

        for (let i = 0; i < 4; i += 1) await service.sendToNamespace('default', makePayload())
        expect(service.isHealthy()).toBe(true)

        await service.sendToNamespace('default', makePayload())
        expect(service.isHealthy()).toBe(false)
    })

    it('does not count invalid-token outcomes against health', async () => {
        const store = new Store(':memory:')
        registerIosDevice(store, 'default', 'good-token', 'iphone-good')
        registerIosDevice(store, 'default', 'dead-token', 'iphone-dead')
        const service = new IosPushService(makeTransport((request) =>
            request.token === 'good-token' ? 'sent' : 'invalid'
        ), store)

        await service.sendToNamespace('default', makePayload())
        expect(service.isHealthy()).toBe(true)
    })
})
