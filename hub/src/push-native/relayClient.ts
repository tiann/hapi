import type { EncryptedPushRequest, NativePushSendOutcome, EncryptedPushTransport, NativePushPlatform } from './transport'

export const RELAY_REQUEST_TIMEOUT_MS = 10_000
export const DEFAULT_PUSH_RELAY_URL = 'https://push.hapi.run'

/**
 * Relay transport: POST `{relayUrl}/v1/push` with the encrypted envelope.
 * The relay owns the APNs/FCM credentials for the official apps; it forwards
 * ciphertext only (see envelope.ts - the relay cannot decrypt).
 *
 * Response contract (PUSH SPEC v1):
 *   200 {ok:true}                        -> sent
 *   410 {ok:false, code:"unregistered"}  -> invalid (prune the device row)
 *   413 payload too large                -> failed (transient; do not prune)
 *   429 rate limited                     -> failed (transient; do not prune)
 *   anything else / network error        -> failed
 */
export class RelayClient implements EncryptedPushTransport {
    private readonly pushUrl: string

    constructor(
        relayUrl: string,
        private readonly platform: NativePushPlatform,
        private readonly requestTimeoutMs: number = RELAY_REQUEST_TIMEOUT_MS
    ) {
        this.pushUrl = `${relayUrl.replace(/\/+$/, '')}/v1/push`
    }

    async send(request: EncryptedPushRequest): Promise<NativePushSendOutcome> {
        const body: Record<string, unknown> = {
            platform: this.platform,
            token: request.token,
            envelope: request.envelope
        }
        if (request.collapseId) {
            body.collapseId = request.collapseId
        }
        if (request.priority !== undefined) {
            body.priority = request.priority
        }

        let response: Response
        try {
            response = await fetch(this.pushUrl, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(this.requestTimeoutMs)
            })
        } catch {
            console.error('[RelayClient] Send failed:', this.platform, 'network')
            return 'failed'
        }

        const result: unknown = await response.json().catch(() => null)
        const reply = typeof result === 'object' && result !== null && !Array.isArray(result)
            ? result as Record<string, unknown> : null
        if (response.status === 200 && reply?.ok === true) {
            return 'sent'
        }
        if (response.status === 410 && reply?.ok === false && reply.code === 'unregistered') {
            return 'invalid'
        }
        // Upstream bodies may echo a device token or other request data.
        console.error('[RelayClient] Send failed:', this.platform, response.status)
        return 'failed'
    }
}
