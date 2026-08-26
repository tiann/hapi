import type { Store } from '../store'
import { PUSH_KEY_LENGTH, canonicalJson, encryptEnvelope } from './envelope'
import type { IosPushSendOutcome, IosPushTransport } from './transport'

/**
 * Notification plaintext (PUSH SPEC v1): exactly the FCM data-contract
 * fields. Serialized with canonicalJson (recursively sorted keys, undefined
 * dropped) before encryption so the ciphertext is deterministic and the iOS
 * decrypt side can pin golden vectors.
 */
export type IosPushNotificationPayload = {
    type: string
    sessionId: string
    sessionName?: string
    url?: string
    title: string
    body: string
    severity?: 'info' | 'success' | 'warning' | 'error'
    contractVersion: string
    requestId?: string
    notifySummary?: string
}

export type IosPushSendResult = {
    sent: number
    failed: number
    invalidTokens: string[]
}

const APNS_COLLAPSE_ID_MAX_BYTES = 64

/**
 * APNs collapse id: `<type>-<sessionId>`, truncated to 64 bytes on a UTF-8
 * character boundary (APNs rejects oversized collapse ids outright).
 */
export function buildCollapseId(type: string, sessionId: string): string {
    const raw = `${type}-${sessionId}`
    if (Buffer.byteLength(raw, 'utf8') <= APNS_COLLAPSE_ID_MAX_BYTES) {
        return raw
    }
    let out = ''
    let bytes = 0
    for (const ch of raw) {
        const chBytes = Buffer.byteLength(ch, 'utf8')
        if (bytes + chBytes > APNS_COLLAPSE_ID_MAX_BYTES) break
        out += ch
        bytes += chBytes
    }
    return out
}

/**
 * Encrypt-then-route fan-out for iOS devices. Mirrors FcmService: per-device
 * outcomes split into sent / invalid (prune) / failed (transient), plus the
 * same rolling-window health gate the native-fallback probe consults.
 */
export class IosPushService {
    /**
     * Rolling window of the last N send outcomes. Drives `isHealthy()` with
     * the same semantics as FcmService: positive evidence required (empty
     * buffer = unhealthy) and `invalid` outcomes excluded - a dead token is
     * a per-device fact, not a pipeline-broken signal.
     */
    private recentOutcomes: Array<'sent' | 'failed'> = []
    private static readonly HEALTH_WINDOW = 8
    private static readonly HEALTH_FAILURE_THRESHOLD = 5

    constructor(
        private readonly transport: IosPushTransport,
        private readonly store: Store
    ) {}

    isHealthy(): boolean {
        const successes = this.recentOutcomes.filter((o) => o === 'sent').length
        if (successes === 0) return false
        const failures = this.recentOutcomes.filter((o) => o === 'failed').length
        return failures < IosPushService.HEALTH_FAILURE_THRESHOLD
    }

    private recordOutcome(outcome: 'sent' | 'failed'): void {
        this.recentOutcomes.push(outcome)
        if (this.recentOutcomes.length > IosPushService.HEALTH_WINDOW) {
            this.recentOutcomes.shift()
        }
    }

    async sendToNamespace(namespace: string, payload: IosPushNotificationPayload): Promise<IosPushSendResult> {
        const devices = this.store.fcm.getDevicesByNamespace(namespace, ['ios'])
        if (devices.length === 0) {
            return { sent: 0, failed: 0, invalidTokens: [] }
        }

        const plaintext = canonicalJson(payload)
        const collapseId = buildCollapseId(payload.type, payload.sessionId)

        const invalidTokens: string[] = []
        let sent = 0
        let failed = 0

        await Promise.all(devices.map(async (device) => {
            const outcome = await this.sendToDevice(device.token, device.pushKey, plaintext, collapseId)
            // `invalid` is a per-device fact - exclude it from the health
            // buffer (see field doc above).
            if (outcome === 'sent') {
                this.recordOutcome('sent')
            } else if (outcome === 'failed') {
                this.recordOutcome('failed')
            }
            if (outcome === 'sent') {
                sent += 1
                return
            }
            failed += 1
            if (outcome === 'invalid') {
                invalidTokens.push(device.token)
                this.store.fcm.removeDeviceByToken(namespace, device.token)
            }
        }))

        return { sent, failed, invalidTokens }
    }

    private async sendToDevice(
        token: string,
        pushKeyB64: string | null,
        plaintext: string,
        collapseId: string
    ): Promise<IosPushSendOutcome> {
        // The register route guarantees a valid 32-byte key for ios rows, so
        // a bad key here is a permanently-corrupt row: it can never decrypt
        // anything and would black-hole every future notification. Prune it
        // (same treatment as a dead token) rather than retrying forever.
        const pushKey = pushKeyB64 ? Buffer.from(pushKeyB64, 'base64') : null
        if (!pushKey || pushKey.length !== PUSH_KEY_LENGTH) {
            console.error('[IosPushService] Device row has missing/invalid pushKey; pruning')
            return 'invalid'
        }

        let envelope: string
        try {
            envelope = encryptEnvelope(pushKey, plaintext)
        } catch (e) {
            console.error('[IosPushService] Envelope encryption failed:', e instanceof Error ? e.message : e)
            return 'failed'
        }

        try {
            return await this.transport.send({ token, envelope, collapseId, priority: 10 })
        } catch (e) {
            // Transports classify their own errors; a throw is a bug or a
            // truly unexpected condition - treat as transient.
            console.error('[IosPushService] Transport threw:', e instanceof Error ? e.message : e)
            return 'failed'
        }
    }
}
