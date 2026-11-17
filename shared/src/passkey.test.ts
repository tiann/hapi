import { describe, expect, it } from 'bun:test'
import {
    canonicalPasskeyHub, encodePasskeyChallenge, validatePasskeyChallenge, encodePasskeyUserHandle,
    validatePasskeyUserHandle, passkeyBase64url, passkeyDecode, passkeyUserHandleHub,
    passkeyDiscoveryOptions, type PasskeyChallenge
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
    it('discovery never accepts a caller challenge, extensions or a Hub identity', () => {
        const a = passkeyDiscoveryOptions('browser')
        const b = passkeyDiscoveryOptions('native')
        expect(a.challenge).not.toBe(b.challenge)
        expect(a).toMatchObject({ rpId: 'auth.hapi.run', userVerification: 'required' })
        expect(a).not.toHaveProperty('allowCredentials')
        expect(a).not.toHaveProperty('extensions')
        expect(JSON.parse(new TextDecoder().decode(passkeyDecode(a.challenge)))).toMatchObject({ operation: 'discover', channel: 'browser' })
        expect(() => validatePasskeyChallenge(a.challenge, hub, 'login', 'browser')).toThrow()
    })
})
