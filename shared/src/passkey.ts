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

export function encodePasskeyChallenge(value: PasskeyChallenge | PasskeyNativeLoginChallenge): string {
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

// v2: [version, authority length, authority, 16-byte account tag]. HTTPS is
// implicit. Length 0 means [version, 0, SHA256(origin), tag] for long origins;
// these credentials remain usable with an explicitly entered Hub address.
export const PASSKEY_HANDLE_VERSION = 2
export const PASSKEY_ACCOUNT_TAG_BYTES = 16
export const PASSKEY_MAX_AUTHORITY_BYTES = 46

export async function encodePasskeyUserHandle(hub: string, accountTag: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
    if (accountTag.length !== PASSKEY_ACCOUNT_TAG_BYTES) throw new Error('Invalid passkey account tag')
    const origin = canonicalPasskeyHub(hub)
    const authority = new TextEncoder().encode(new URL(origin).host)
    const discoverable = authority.length <= PASSKEY_MAX_AUTHORITY_BYTES
    const address = discoverable ? authority : new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(origin)))
    return Uint8Array.from([PASSKEY_HANDLE_VERSION, discoverable ? address.length : 0, ...address, ...accountTag])
}

/** Locator only, never authentication evidence. Reject noncanonical addresses
 * before any connection. null = deliberately opaque (long address). */
export function passkeyUserHandleHub(handle: Uint8Array): string | null {
    if (handle[0] !== PASSKEY_HANDLE_VERSION || handle.length > 64) throw new Error('Invalid passkey account')
    const length = handle[1]
    if (length === 0 && handle.length === 50) return null
    if (!length || length > PASSKEY_MAX_AUTHORITY_BYTES || handle.length !== length + 18) throw new Error('Invalid passkey account')
    const authority = new TextDecoder('utf-8', { fatal: true }).decode(handle.subarray(2, 2 + length))
    const origin = `https://${authority}`
    if (!/^[\x21-\x7e]+$/.test(authority) || canonicalPasskeyHub(origin) !== origin) throw new Error('Invalid passkey Hub address')
    return origin
}

export async function validatePasskeyUserHandle(encoded: string, hub: string): Promise<void> {
    const handle = passkeyDecode(encoded)
    const discovered = passkeyUserHandleHub(handle)
    const origin = canonicalPasskeyHub(hub)
    if (discovered !== null) {
        if (discovered === origin) return
    } else {
        const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(origin)))
        if (hash.every((byte, index) => byte === handle[index + 2])) return
    }
    throw new Error('Passkey account does not belong to this Hub')
}

/** Native sign-in has no Hub before the ceremony: the app signs its own fresh
 * challenge, reads the Hub from the selected credential's user handle, and
 * posts the assertion there. The Hub accepts it only within a short window and
 * only once. Browser ceremonies keep Hub-issued challenges. */
export const PASSKEY_NATIVE_LOGIN_VERSION = 2
export const PASSKEY_NATIVE_LOGIN_MAX_AGE_MS = 5 * 60 * 1000
export const PASSKEY_NATIVE_LOGIN_MAX_SKEW_MS = 60 * 1000

export type PasskeyNativeLoginChallenge = {
    v: typeof PASSKEY_NATIVE_LOGIN_VERSION
    operation: 'login'
    channel: 'native'
    iat: number
    nonce: string
}

const NATIVE_LOGIN_KEYS = ['channel', 'iat', 'nonce', 'operation', 'v']

export function createPasskeyNativeLoginChallenge(now: number = Date.now()): string {
    return encodePasskeyChallenge({
        v: PASSKEY_NATIVE_LOGIN_VERSION, operation: 'login', channel: 'native', iat: now,
        nonce: passkeyBase64url(crypto.getRandomValues(new Uint8Array(32)))
    })
}

/** Throws unless `encoded` is a well-formed, currently fresh native login challenge. */
export function parsePasskeyNativeLoginChallenge(encoded: string, now: number): PasskeyNativeLoginChallenge {
    if (encoded.length > 512) throw new Error('Invalid passkey challenge')
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(passkeyDecode(encoded)))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid passkey challenge')
    const c = value as Partial<PasskeyNativeLoginChallenge>
    if (Object.keys(c).sort().join() !== NATIVE_LOGIN_KEYS.join()
        || c.v !== PASSKEY_NATIVE_LOGIN_VERSION || c.operation !== 'login' || c.channel !== 'native'
        || typeof c.nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(c.nonce)
        || typeof c.iat !== 'number' || !Number.isSafeInteger(c.iat)) {
        throw new Error('Invalid passkey challenge')
    }
    if (c.iat < now - PASSKEY_NATIVE_LOGIN_MAX_AGE_MS || c.iat > now + PASSKEY_NATIVE_LOGIN_MAX_SKEW_MS) {
        throw new Error('Passkey challenge expired')
    }
    return c as PasskeyNativeLoginChallenge
}
