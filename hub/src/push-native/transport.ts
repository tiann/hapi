/**
 * Encrypted native push delivery: direct APNs or the iOS/Android relay.
 *
 *  - `ApnsClient`   direct HTTP/2 to Apple's APNs (self-host: operator owns
 *                   the APNs auth key + bundle id)
 *  - `RelayClient`  plain HTTPS POST to a hapi push relay, which holds the
 *                   APNs/FCM credentials for the official apps
 *
 * Both only ever carry the encrypted envelope - neither transport (nor
 * Apple or Google) can read the notification plaintext.
 */

export type EncryptedPushRequest = {
    /** Opaque device token; only APNs tokens are hexadecimal. */
    token: string
    /** base64(nonce || ciphertext || tag) - see envelope.ts. */
    envelope: string
    /** APNs collapse id, `<type>-<sessionId>` truncated to 64 bytes. */
    collapseId?: string
    /** 10 = immediate/high, 5 = normal. */
    priority?: number
}

export type NativePushPlatform = 'ios' | 'android'

/**
 * Per-device send outcome. Same semantics as the FCM service:
 *  - `sent`     accepted by the transport
 *  - `invalid`  the token is permanently dead (APNs 410 Unregistered /
 *               400 BadDeviceToken, relay 410) - safe to prune the row
 *  - `failed`   transient (network, 5xx, 429, auth glitch) - keep the row
 */
export type NativePushSendOutcome = 'sent' | 'invalid' | 'failed'

export type EncryptedPushTransport = {
    send(request: EncryptedPushRequest): Promise<NativePushSendOutcome>
}
