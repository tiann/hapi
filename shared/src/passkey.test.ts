import { describe, expect, it } from 'bun:test'
import {
    canonicalPasskeyHub, encodePasskeyChallenge, validatePasskeyChallenge, encodePasskeyUserHandle,
    validatePasskeyUserHandle, passkeyBase64url, passkeyDecode, passkeyUserHandleHub,
    createPasskeyNativeLoginChallenge, parsePasskeyNativeLoginChallenge, PASSKEY_NATIVE_LOGIN_MAX_AGE_MS,
    PASSKEY_NATIVE_LOGIN_MAX_SKEW_MS, type PasskeyChallenge
} from './passkey'

const hub = 'https://hub.example.com'
const challenge: PasskeyChallenge = { v: 1, hub, id: 'a'.repeat(43), nonce: 'b'.repeat(43), operation: 'login', channel: 'browser' }
const tag = new Uint8Array(16).fill(1)

describe('passkey Hub isolation', () => {
    it('canonicalizes HTTPS origins, never credentials/paths or insecure URLs', () => {
        expect(canonicalPasskeyHub('https://HUB.example.com:443/')).toBe(hub)
        for (const invalid of ['http://hub.example.com', 'https://u:p@hub.example.com', `${hub}/other`, `${hub}/?q=1`, `${hub}/#f`]) {
            expect(() => canonicalPasskeyHub(invalid)).toThrow()
        }
    })
    it('validates Hub, operation, channel, version, and unpredictable nonce shape', () => {
        const encoded = encodePasskeyChallenge(challenge)
        expect(validatePasskeyChallenge(encoded, hub, 'login', 'browser')).toEqual(challenge)
        for (const changed of [{ hub: 'https://other.example' }, { operation: 'register' }, { channel: 'native' }, { v: 0 }, { nonce: '' }, { id: '' }]) {
            expect(() => validatePasskeyChallenge(encodePasskeyChallenge({ ...challenge, ...changed } as PasskeyChallenge), hub, 'login', 'browser')).toThrow()
        }
        for (const invalid of ['!', 'a', 'x'.repeat(5000), passkeyBase64url(new TextEncoder().encode('null'))]) {
            expect(() => validatePasskeyChallenge(invalid, hub, 'login', 'browser')).toThrow()
        }
    })
    it('stores a recoverable HTTPS authority with a 128-bit isolated account tag', async () => {
        for (const origin of [hub, 'https://hub.example.com:8443', 'https://[2001:db8::1]:8443', 'https://xn--fiqs8s.example']) {
            const handle = await encodePasskeyUserHandle(origin, tag)
            expect(handle.length).toBeLessThanOrEqual(64)
            expect(passkeyUserHandleHub(handle)).toBe(origin)
            expect(handle.subarray(-16)).toEqual(tag)
            expect(passkeyDecode(passkeyBase64url(handle))).toEqual(handle)
            await validatePasskeyUserHandle(passkeyBase64url(handle), origin)
            await expect(validatePasskeyUserHandle(passkeyBase64url(handle), 'https://other.example')).rejects.toThrow()
        }
        // Cross-language vector pinned by Swift and Kotlin tests.
        expect(Buffer.from(await encodePasskeyUserHandle('https://hub.test', tag)).toString('hex'))
            .toBe('02086875622e7465737401010101010101010101010101010101')
    })
    it('supports the exact 64-byte boundary and hash-binds longer addresses', async () => {
        const fits = `https://${'a'.repeat(42)}.com`
        expect((await encodePasskeyUserHandle(fits, tag)).length).toBe(64)
        const long = `https://${'a'.repeat(43)}.com`
        const handle = await encodePasskeyUserHandle(long, tag)
        expect(handle.length).toBe(50)
        expect(passkeyUserHandleHub(handle)).toBeNull()
        await validatePasskeyUserHandle(passkeyBase64url(handle), long)
        await expect(validatePasskeyUserHandle(passkeyBase64url(handle), hub)).rejects.toThrow()
        await expect(encodePasskeyUserHandle(hub, new Uint8Array(15))).rejects.toThrow()
    })
    it('rejects malformed, old, noncanonical and redirect-like locators', () => {
        const make = (authority: string) => Uint8Array.from([2, authority.length, ...new TextEncoder().encode(authority), ...tag])
        for (const authority of ['HUB.test', 'hub.test:443', 'u:p@hub.test', 'hub.test/path', 'hub.test?x', 'hub.test#x', 'hub.test/', 'hub.test\\evil', 'hub.test\n']) {
            expect(() => passkeyUserHandleHub(make(authority))).toThrow()
        }
        for (const bytes of [new Uint8Array(), new Uint8Array(64), Uint8Array.of(2, 0), Uint8Array.of(2, 1, 65), new Uint8Array(65).fill(2)]) {
            expect(() => passkeyUserHandleHub(bytes)).toThrow()
        }
    })
    it('accepts only fresh, exact native login challenges that no Hub-bound ceremony can produce', () => {
        const now = 1_800_000_000_000
        const encoded = createPasskeyNativeLoginChallenge(now)
        expect(parsePasskeyNativeLoginChallenge(encoded, now)).toMatchObject({ v: 2, operation: 'login', channel: 'native', iat: now })
        expect(createPasskeyNativeLoginChallenge(now)).not.toBe(encoded)
        expect(parsePasskeyNativeLoginChallenge(encoded, now + PASSKEY_NATIVE_LOGIN_MAX_AGE_MS).iat).toBe(now)
        expect(parsePasskeyNativeLoginChallenge(encoded, now - PASSKEY_NATIVE_LOGIN_MAX_SKEW_MS).iat).toBe(now)
        expect(() => parsePasskeyNativeLoginChallenge(encoded, now + PASSKEY_NATIVE_LOGIN_MAX_AGE_MS + 1)).toThrow('expired')
        expect(() => parsePasskeyNativeLoginChallenge(encoded, now - PASSKEY_NATIVE_LOGIN_MAX_SKEW_MS - 1)).toThrow('expired')
        const base = JSON.parse(new TextDecoder().decode(passkeyDecode(encoded)))
        const encode = (value: unknown) => passkeyBase64url(new TextEncoder().encode(JSON.stringify(value)))
        for (const changed of [{ v: 1 }, { operation: 'register' }, { channel: 'browser' }, { iat: '1' }, { iat: now + 0.5 }, { nonce: 'short' }, { hub }, { extra: 1 }]) {
            expect(() => parsePasskeyNativeLoginChallenge(encode({ ...base, ...changed }), now)).toThrow()
        }
        expect(() => parsePasskeyNativeLoginChallenge(encode([base]), now)).toThrow()
        expect(() => parsePasskeyNativeLoginChallenge(encodePasskeyChallenge({ ...challenge, channel: 'native' }), now)).toThrow()
        expect(() => validatePasskeyChallenge(encoded, hub, 'login', 'native')).toThrow()
        // Cross-language vector pinned by Swift and Kotlin tests (key order is irrelevant).
        const vector = encode({ v: 2, operation: 'login', channel: 'native', iat: now, nonce: 'A'.repeat(43) })
        expect(parsePasskeyNativeLoginChallenge(vector, now).nonce).toBe('A'.repeat(43))
    })
})
