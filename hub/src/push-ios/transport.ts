/**
 * Transport abstraction for iOS push delivery. Two implementations:
 *
 *  - `ApnsClient`   direct HTTP/2 to Apple's APNs (self-host: operator owns
 *                   the APNs auth key + bundle id)
 *  - `RelayClient`  plain HTTPS POST to a hapi push relay, which holds the
 *                   APNs credentials for the official app
 *
 * Both only ever carry the encrypted envelope - neither transport (nor
 * Apple) can read the notification plaintext.
 */

export type IosPushRequest = {
    /** Hex APNs device token as registered by the device. */
    token: string
    /** base64(nonce || ciphertext || tag) - see envelope.ts. */
    envelope: string
    /** APNs collapse id, `<type>-<sessionId>` truncated to 64 bytes. */
    collapseId?: string
    /** APNs priority; defaults to 10 (immediate). */
    priority?: number
}

/**
 * Per-device send outcome. Same semantics as the FCM service:
 *  - `sent`     accepted by the transport
 *  - `invalid`  the token is permanently dead (APNs 410 Unregistered /
 *               400 BadDeviceToken, relay 410) - safe to prune the row
 *  - `failed`   transient (network, 5xx, 429, auth glitch) - keep the row
 */
export type IosPushSendOutcome = 'sent' | 'invalid' | 'failed'

export type IosPushTransport = {
    send(request: IosPushRequest): Promise<IosPushSendOutcome>
}
