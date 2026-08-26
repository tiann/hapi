import type { IosPushRequest, IosPushSendOutcome, IosPushTransport } from './transport'

export const RELAY_REQUEST_TIMEOUT_MS = 10_000

/**
 * Relay transport: POST `{relayUrl}/v1/push` with the encrypted envelope.
 * The relay owns the APNs credentials for the official app; it forwards
 * ciphertext only (see envelope.ts - the relay cannot decrypt).
 *
 * Response contract (PUSH SPEC v1):
 *   200 {ok:true}                        -> sent
 *   410 {ok:false, code:"unregistered"}  -> invalid (prune the device row)
 *   413 payload too large                -> failed (transient; do not prune)
 *   429 rate limited                     -> failed (transient; do not prune)
 *   anything else / network error        -> failed
 */
export class RelayClient implements IosPushTransport {
    private readonly pushUrl: string

    constructor(relayUrl: string, private readonly requestTimeoutMs: number = RELAY_REQUEST_TIMEOUT_MS) {
        this.pushUrl = `${relayUrl.replace(/\/+$/, '')}/v1/push`
    }

    async send(request: IosPushRequest): Promise<IosPushSendOutcome> {
        const body: Record<string, unknown> = {
            platform: 'ios',
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
        } catch (e) {
            console.error('[RelayClient] Send threw:', e instanceof Error ? e.message : e)
            return 'failed'
        }

        if (response.ok) {
            return 'sent'
        }
        if (response.status === 410) {
            return 'invalid'
        }
        const text = await response.text().catch(() => '')
        console.error('[RelayClient] Send failed (transient):', response.status, text.slice(0, 200))
        return 'failed'
    }
}
