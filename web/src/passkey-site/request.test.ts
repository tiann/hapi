import { webcrypto } from 'node:crypto'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { encodePasskeyChallenge, encodePasskeyUserHandle, passkeyBase64url, PASSKEY_RP_ID } from '@hapi/protocol/passkey'
import { parseCeremonyRequest } from './request'

beforeAll(() => { vi.stubGlobal('crypto', webcrypto) })
const hub = 'https://hub.example.com'
function request(operation: 'login' | 'register' = 'login') {
    const challenge = encodePasskeyChallenge({ v: 1, hub, id: 'a'.repeat(43), nonce: 'b'.repeat(43), operation, channel: 'browser' })
    return { hub, operation, options: { challenge, rpId: PASSKEY_RP_ID, allowCredentials: [{ id: 'Y3JlZA', type: 'public-key' }] } }
}
const fragment = (r: unknown) => `#${encodeURIComponent(JSON.stringify(r))}`

describe('static passkey bridge', () => {
    it('pins the RP and user verification, ignoring untrusted extensions', async () => {
        const input = { ...request(), options: { ...request().options, userVerification: 'discouraged', extensions: { largeBlob: { read: true } } } }
        const result = await parseCeremonyRequest(fragment(input))
        expect(result.operation === 'discover' ? null : result.options).toMatchObject({ rpId: PASSKEY_RP_ID, userVerification: 'required' })
        expect(result.operation === 'discover' ? null : result.options).not.toHaveProperty('extensions')
    })
    it('rejects a malicious Hub proxying another Hub challenge', async () => {
        await expect(parseCeremonyRequest(fragment({ ...request(), hub: 'https://evil.example' }))).rejects.toThrow()
    })
    it('rejects native-channel challenges, wrong RPs, and unrestricted discovery', async () => {
        const input = request()
        const native = encodePasskeyChallenge({ v: 1, hub, id: 'a'.repeat(43), nonce: 'b'.repeat(43), operation: 'login', channel: 'native' })
        for (const options of [{ ...input.options, challenge: native }, { ...input.options, rpId: 'evil.example' }, { ...input.options, allowCredentials: [] }]) {
            await expect(parseCeremonyRequest(fragment({ ...input, options }))).rejects.toThrow()
        }
    })
    it('validates registration account binding and strips RP/attestation/extension choices', async () => {
        const bytes = await encodePasskeyUserHandle(hub, new Uint8Array(16))
        const input = {
            ...request('register'), options: {
                challenge: request('register').options.challenge, rp: { id: PASSKEY_RP_ID, name: 'untrusted' },
                user: { id: passkeyBase64url(bytes), name: 'hapi@hub.example.com', displayName: 'untrusted' }
            }
        }
        const result = await parseCeremonyRequest(fragment(input))
        expect(result.operation === 'discover' ? null : result.options).toMatchObject({ rp: { id: PASSKEY_RP_ID, name: 'HAPI' }, attestation: 'none' })
        await expect(parseCeremonyRequest(fragment({ ...input, options: { ...input.options, user: { ...input.options.user, id: 'YQ' } } }))).rejects.toThrow()
    })
    it('rejects malformed or oversized input and non-HTTPS Hub identities', async () => {
        for (const input of ['#null', '#%zz', '#'+ 'x'.repeat(400000), fragment({ ...request(), hub: 'http://hub.example.com' })]) {
            await expect(parseCeremonyRequest(input)).rejects.toThrow()
        }
    })
})


it('allows only the minimal discovery request and never caller-supplied options', async () => {
    const request = { operation: 'discover', callbackOrigin: 'https://app.example', state: 'a'.repeat(43) }
    expect(await parseCeremonyRequest(fragment(request))).toEqual(request)
    for (const changed of [{ state: 'short' }, { callbackOrigin: 'http://app.example' }, { options: { challenge: 'proxied' } }, { hub: 'https://victim.example' }]) {
        await expect(parseCeremonyRequest(fragment({ ...request, ...changed }))).rejects.toThrow()
    }
})
