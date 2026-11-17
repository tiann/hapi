import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import {
    canonicalPasskeyHub, encodePasskeyChallenge, validatePasskeyChallenge,
    validatePasskeyUserHandle, passkeyBase64url, passkeyDecode, type PasskeyChallenge
} from './passkey'

const hub = 'https://hub.example.com'
const challenge: PasskeyChallenge = { v: 1, hub, id: 'a'.repeat(43), nonce: 'b'.repeat(43), operation: 'login', channel: 'browser' }

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
    it('binds the account handle to its Hub and round-trips base64url', async () => {
        const bytes = Buffer.concat([createHash('sha256').update(hub).digest(), Buffer.alloc(32, 1)])
        const encoded = passkeyBase64url(bytes)
        expect(Buffer.from(passkeyDecode(encoded))).toEqual(bytes)
        await validatePasskeyUserHandle(encoded, hub)
        await expect(validatePasskeyUserHandle(encoded, 'https://other.example')).rejects.toThrow()
        await expect(validatePasskeyUserHandle(passkeyBase64url(bytes.subarray(0, 63)), hub)).rejects.toThrow()
    })
})
