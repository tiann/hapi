import { describe, expect, it } from 'bun:test'
import { Store } from '../store'
import { decryptEnvelope, encryptEnvelope } from '../push-native/envelope'
import type { EncryptedPushRequest } from '../push-native/transport'
import { AndroidRelayService, androidRelayPlaintext, MAX_ANDROID_RELAY_ENVELOPE_BYTES } from './androidRelayService'
import type { FcmSendPayload } from './fcmService'

const payload: FcmSendPayload = {
    title: 'Permission Request', body: 'Run command?',
    data: { type: 'permission-request', title: 'Permission Request', body: 'Run command?', sessionId: 's1',
        sessionName: 'demo', url: '/sessions/s1', requestId: 'r1', contractVersion: '1' }
}

describe('Android relay fan-out', () => {
    it('encrypts independently per phone, filters platform/namespace and keeps old registrations', async () => {
        const store = new Store(':memory:')
        const keyA = Buffer.alloc(32, 1)
        const keyB = Buffer.alloc(32, 2)
        for (const [token, key] of [['token-A', keyA], ['token-B', keyB]] as const) {
            store.fcm.upsertDevice('ns', { token, deviceId: token, platform: 'phone', pushKey: key.toString('base64') })
        }
        store.fcm.upsertDevice('ns', { token: 'old', deviceId: 'old', platform: 'phone' })
        store.fcm.upsertDevice('ns', { token: 'watch', deviceId: 'watch', platform: 'wear' })
        store.fcm.upsertDevice('ns', { token: 'ios', deviceId: 'ios', platform: 'ios', pushKey: keyA.toString('base64') })
        store.fcm.upsertDevice('other', { token: 'other', deviceId: 'other', platform: 'phone', pushKey: keyA.toString('base64') })
        const requests: EncryptedPushRequest[] = []
        const service = new AndroidRelayService({ async send(request) { requests.push(request); return 'sent' } }, store)
        expect(await service.sendToNamespace('ns', payload)).toEqual({ sent: 2, failed: 1, invalidTokens: [] })
        for (const request of requests) {
            const key = request.token === 'token-A' ? keyA : keyB
            expect(JSON.parse(decryptEnvelope(key, request.envelope))).toEqual(payload.data)
            expect(() => decryptEnvelope(request.token === 'token-A' ? keyB : keyA, request.envelope)).toThrow()
            expect(request.collapseId).toBeUndefined()
        }
        expect(store.fcm.getDevicesByNamespace('ns')).toHaveLength(5)
        store.close()
    })

    it('prunes only confirmed dead tokens, preserving failed sends and corrupt keys', async () => {
        const store = new Store(':memory:')
        for (const token of ['dead', 'network', 'corrupt']) {
            store.fcm.upsertDevice('ns', { token, deviceId: token, platform: 'phone',
                pushKey: token === 'corrupt' ? 'bad' : Buffer.alloc(32).toString('base64') })
        }
        const service = new AndroidRelayService({ async send(request) {
            if (request.token === 'network') throw new Error('offline')
            return 'invalid'
        } }, store)
        expect(await service.sendToNamespace('ns', payload)).toEqual({ sent: 0, failed: 3, invalidTokens: ['dead'] })
        expect(store.fcm.getDevicesByNamespace('ns').map(d => d.token).sort()).toEqual(['corrupt', 'network'])
        store.close()
    })

    it('fits large summaries and Unicode content without truncating action identifiers', () => {
        const largeSummary = { ...payload.data, notifySummary: '中'.repeat(4000) }
        const text = androidRelayPlaintext(largeSummary)!
        expect(JSON.parse(text)).toEqual(payload.data)
        const minimal = androidRelayPlaintext({ ...largeSummary, body: '😀'.repeat(4000), title: '大'.repeat(4000) })!
        expect(JSON.parse(minimal)).toEqual({ type: 'permission-request', sessionId: 's1', requestId: 'r1',
            contractVersion: '1', title: 'HAPI', body: 'New activity' })
        expect(encryptEnvelope(Buffer.alloc(32), minimal).length).toBeLessThanOrEqual(MAX_ANDROID_RELAY_ENVELOPE_BYTES)
        expect(androidRelayPlaintext({ ...largeSummary, sessionId: 's'.repeat(4000) })).toBeNull()
    })
})
