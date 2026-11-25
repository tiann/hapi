import type { Store } from '../store'
import { canonicalJson, encryptEnvelope, PUSH_KEY_LENGTH, PUSH_NONCE_LENGTH, PUSH_TAG_LENGTH } from '../push-native/envelope'
import type { EncryptedPushTransport } from '../push-native/transport'
import type { AndroidPushSender, FcmSendPayload, FcmSendResult } from './fcmService'

/** Keep in sync with the standalone relay's MAX_ENVELOPE_BYTES. */
export const MAX_ANDROID_RELAY_ENVELOPE_BYTES = 3200

function fitsEnvelope(plaintext: string): boolean {
    const bytes = Buffer.byteLength(plaintext, 'utf8') + PUSH_NONCE_LENGTH + PUSH_TAG_LENGTH
    return 4 * Math.ceil(bytes / 3) <= MAX_ANDROID_RELAY_ENVELOPE_BYTES
}

/** Never cut ciphertext or action identifiers to fit a push provider's budget. */
export function androidRelayPlaintext(data: FcmSendPayload['data']): string | null {
    const full = canonicalJson(data)
    if (fitsEnvelope(full)) return full
    const { notifySummary: _summary, ...withoutSummary } = data
    const compact = canonicalJson(withoutSummary)
    if (fitsEnvelope(compact)) return compact
    const minimal = canonicalJson({
        type: data.type,
        sessionId: data.sessionId,
        requestId: data.requestId,
        contractVersion: data.contractVersion,
        title: 'HAPI',
        body: 'New activity'
    })
    return fitsEnvelope(minimal) ? minimal : null
}

export class AndroidRelayService implements AndroidPushSender {
    constructor(private readonly transport: EncryptedPushTransport, private readonly store: Store) {}

    async sendToNamespace(namespace: string, payload: FcmSendPayload): Promise<FcmSendResult> {
        const devices = this.store.fcm.getDevicesByNamespace(namespace, ['phone'])
        const result: FcmSendResult = { sent: 0, failed: 0, invalidTokens: [] }
        if (!devices.length) return result
        const plaintext = androidRelayPlaintext(payload.data)
        await Promise.all(devices.map(async device => {
            const key = device.pushKey ? Buffer.from(device.pushKey, 'base64') : null
            // Old registrations heal on app upgrade/start. Missing keys and
            // oversized content say nothing about the lifetime of a token.
            if (!key || key.length !== PUSH_KEY_LENGTH || plaintext === null) {
                result.failed += 1
                return
            }
            try {
                const outcome = await this.transport.send({
                    token: device.token,
                    envelope: encryptEnvelope(key, plaintext),
                    priority: 10
                })
                if (outcome === 'sent') {
                    result.sent += 1
                    return
                }
                if (outcome === 'invalid') {
                    this.store.fcm.removeDeviceByToken(namespace, device.token)
                    result.invalidTokens.push(device.token)
                }
            } catch {
                console.error('[AndroidPush] Relay send failed')
            }
            result.failed += 1
        }))
        return result
    }
}
