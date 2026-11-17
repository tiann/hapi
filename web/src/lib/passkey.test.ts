import { webcrypto } from 'node:crypto'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClient, ApiError } from '@/api/client'
import { PASSKEY_ORIGIN, passkeyBase64url } from '@hapi/protocol/passkey'
import { signInWithPasskey } from './passkey'

const start = vi.spyOn(ApiClient.prototype, 'startPasskeyBrowser')
const exchange = vi.spyOn(ApiClient.prototype, 'exchangePasskeyCode')
const replace = vi.fn()
const close = vi.fn()
const popup = { closed: false, location: { replace }, close } as unknown as Window

beforeEach(() => {
    Object.assign(popup, { closed: false })
    vi.stubGlobal('crypto', webcrypto)
    vi.spyOn(window, 'open').mockReturnValue(popup)
    start.mockResolvedValue({ url: `${PASSKEY_ORIGIN}/#request` })
    exchange.mockResolvedValue({ operation: 'login', token: 'jwt', passkeySession: 'session' })
})
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals() })

afterAll(() => { vi.restoreAllMocks() })

function callback(data: Record<string, unknown>, origin = window.location.origin, source = popup) {
    window.dispatchEvent(new MessageEvent('message', { origin, source, data: { type: 'hapi-passkey-callback', ...data } }))
}

describe('Passkey browser handoff', () => {
    it('checks popup identity, callback origin and state; keeps PKCE out of the bridge URL', async () => {
        const result = signInWithPasskey('https://hub.example')
        await vi.waitFor(() => expect(replace).toHaveBeenCalled())
        const input = start.mock.calls[0]![1]
        callback({ state: input.state, code: 'bad' }, 'https://evil.example')
        callback({ state: 'bad', code: 'bad' })
        callback({ state: input.state, code: 'bad' }, window.location.origin, window)
        expect(exchange).not.toHaveBeenCalled()
        callback({ state: input.state, code: 'code' })
        expect(await result).toBe('session')
        const verifier = exchange.mock.calls[0]![1]
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
        expect(passkeyBase64url(digest)).toBe(input.codeChallenge)
        expect(replace).toHaveBeenCalledWith(`${PASSKEY_ORIGIN}/#request`)
        expect(close).toHaveBeenCalled()
    })
    it('does not navigate to a Hub-supplied foreign authentication page', async () => {
        start.mockResolvedValueOnce({ url: 'https://evil.example/#request' })
        await expect(signInWithPasskey('https://hub.example')).rejects.toThrow('Unexpected Passkey')
        expect(replace).not.toHaveBeenCalled()
        expect(close).toHaveBeenCalled()
    })
    it('treats a cancelled bridge ceremony as a silent browser cancellation', async () => {
        const result = signInWithPasskey('https://hub.example')
        const rejected = expect(result).rejects.toMatchObject({ name: 'NotAllowedError' })
        await vi.waitFor(() => expect(replace).toHaveBeenCalled())
        callback({ state: start.mock.calls[0]![1].state, error: 'cancelled' })
        await rejected
        expect(exchange).not.toHaveBeenCalled()
    })
    it('allows closing the popup even when the Hub start request stalls', async () => {
        start.mockReturnValueOnce(new Promise(() => {}))
        const result = signInWithPasskey('https://hub.example')
        const rejected = expect(result).rejects.toMatchObject({ name: 'NotAllowedError' })
        await vi.waitFor(() => expect(start).toHaveBeenCalled())
        Object.assign(popup, { closed: true })
        await rejected
        expect(exchange).not.toHaveBeenCalled()
        expect(close).toHaveBeenCalled()
    })
    it('propagates revocation without exchanging a code', async () => {
        const result = signInWithPasskey('https://hub.example')
        const rejected = expect(result).rejects.toMatchObject({ code: 'passkey_revoked' } satisfies Partial<ApiError>)
        await vi.waitFor(() => expect(replace).toHaveBeenCalled())
        callback({ state: start.mock.calls[0]![1].state, error: 'passkey_revoked' })
        await rejected
        expect(exchange).not.toHaveBeenCalled()
    })
})
