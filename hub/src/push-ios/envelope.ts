import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * End-to-end encrypted push envelope (PUSH SPEC v1).
 *
 * The hub encrypts the notification plaintext (the exact FCM data-contract
 * JSON, canonicalized) with a per-device 32-byte key that only the iOS app
 * and the hub know. APNs and the optional relay only ever see ciphertext;
 * the device's Notification Service Extension decrypts and replaces the
 * generic "New activity" alert.
 *
 * Envelope layout: base64( nonce(12) || ciphertext || tag(16) )
 * Cipher: AES-256-GCM, AAD = ASCII "hapi-push-v1".
 *
 * Golden vector: shared/fixtures/push/envelope-v1.json (iOS ports must
 * reproduce it byte-for-byte).
 */

export const PUSH_ENVELOPE_AAD = 'hapi-push-v1'
export const PUSH_KEY_LENGTH = 32
export const PUSH_NONCE_LENGTH = 12
export const PUSH_TAG_LENGTH = 16

/**
 * Canonical JSON: recursively sorted object keys, no whitespace, `undefined`
 * properties dropped. Both sides of the E2E channel serialize the
 * notification with this exact function (or a byte-identical port) so the
 * ciphertext is deterministic for a given (key, nonce, payload).
 */
export function canonicalJson(value: unknown): string {
    return JSON.stringify(sortKeysDeep(value))
}

function sortKeysDeep(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(sortKeysDeep)
    }
    if (value !== null && typeof value === 'object') {
        const record = value as Record<string, unknown>
        const sorted: Record<string, unknown> = {}
        for (const key of Object.keys(record).sort()) {
            const entry = record[key]
            if (entry === undefined) continue
            sorted[key] = sortKeysDeep(entry)
        }
        return sorted
    }
    return value
}

/**
 * Encrypt `plaintext` under `key` and return the base64 envelope.
 * `nonce` is only injectable for tests / vector generation - production
 * callers must let it default to 12 fresh random bytes per message.
 */
export function encryptEnvelope(key: Uint8Array, plaintext: string, nonce?: Uint8Array): string {
    if (key.length !== PUSH_KEY_LENGTH) {
        throw new Error(`push envelope key must be ${PUSH_KEY_LENGTH} bytes, got ${key.length}`)
    }
    const iv = nonce ?? randomBytes(PUSH_NONCE_LENGTH)
    if (iv.length !== PUSH_NONCE_LENGTH) {
        throw new Error(`push envelope nonce must be ${PUSH_NONCE_LENGTH} bytes, got ${iv.length}`)
    }
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(Buffer.from(PUSH_ENVELOPE_AAD, 'ascii'))
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()])
    const tag = cipher.getAuthTag()
    return Buffer.concat([iv, ciphertext, tag]).toString('base64')
}

/**
 * Decrypt a base64 envelope. Throws on truncated envelopes and on any
 * authentication failure (wrong key, flipped bit, altered AAD).
 */
export function decryptEnvelope(key: Uint8Array, envelopeB64: string): string {
    if (key.length !== PUSH_KEY_LENGTH) {
        throw new Error(`push envelope key must be ${PUSH_KEY_LENGTH} bytes, got ${key.length}`)
    }
    const raw = Buffer.from(envelopeB64, 'base64')
    if (raw.length < PUSH_NONCE_LENGTH + PUSH_TAG_LENGTH) {
        throw new Error('push envelope too short')
    }
    const iv = raw.subarray(0, PUSH_NONCE_LENGTH)
    const ciphertext = raw.subarray(PUSH_NONCE_LENGTH, raw.length - PUSH_TAG_LENGTH)
    const tag = raw.subarray(raw.length - PUSH_TAG_LENGTH)
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(Buffer.from(PUSH_ENVELOPE_AAD, 'ascii'))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}
