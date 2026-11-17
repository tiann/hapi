/** Shared RP for native apps and the isolated, static browser ceremony page. */
export const PASSKEY_RP_ID = 'auth.hapi.run'
export const PASSKEY_ORIGIN = `https://${PASSKEY_RP_ID}`
export const PASSKEY_CALLBACK_PATH = '/passkey/callback'
export const PASSKEY_COMPLETE_PATH = '/api/passkey/browser/complete'
export const PASSKEY_MAX_REQUEST_LENGTH = 64 * 1024

export type PasskeyOperation = 'login' | 'register'
export type PasskeyChannel = 'browser' | 'native'
export type PasskeyChallenge = {
    v: 1
    hub: string
    id: string
    operation: PasskeyOperation
    channel: PasskeyChannel
    nonce: string
}

/** No credentials, paths, query strings, or HTTP downgrades in Hub identities. */
export function canonicalPasskeyHub(input: string): string {
    const url = new URL(input)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
        throw new Error('Passkeys require a canonical HTTPS Hub origin')
    }
    return url.origin
}

export function passkeyBase64url(bytes: Uint8Array): string {
    return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function passkeyDecode(value: string): Uint8Array<ArrayBuffer> {
    if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) throw new Error('Invalid base64url')
    const decoded = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4))
    return Uint8Array.from(decoded, (char) => char.charCodeAt(0))
}

export function encodePasskeyChallenge(value: PasskeyChallenge): string {
    return passkeyBase64url(new TextEncoder().encode(JSON.stringify(value)))
}

/** Validate before asking the authenticator to sign: a malicious Hub must not
 * proxy a different Hub's challenge under the shared RP. The issuer still
 * verifies its exact, stored, unpredictable challenge after the ceremony. */
export function validatePasskeyChallenge(
    encoded: string,
    hub: string,
    operation: PasskeyOperation,
    channel: PasskeyChannel
): PasskeyChallenge {
    if (encoded.length > 4096) throw new Error('Invalid passkey challenge')
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(passkeyDecode(encoded)))
    if (!value || typeof value !== 'object') throw new Error('Invalid passkey challenge')
    const c = value as Partial<PasskeyChallenge>
    if (c.v !== 1 || c.hub !== canonicalPasskeyHub(hub) || c.operation !== operation || c.channel !== channel
        || typeof c.id !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(c.id)
        || typeof c.nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(c.nonce)) {
        throw new Error('Passkey challenge does not match this Hub or operation')
    }
    return c as PasskeyChallenge
}

export async function validatePasskeyUserHandle(encoded: string, hub: string): Promise<void> {
    const handle = passkeyDecode(encoded)
    const prefix = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalPasskeyHub(hub))))
    if (handle.length !== 64 || !prefix.every((byte, index) => byte === handle[index])) {
        throw new Error('Passkey account does not belong to this Hub')
    }
}
