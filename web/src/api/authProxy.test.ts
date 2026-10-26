import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthProxyRedirectError, buildAuthProxyReauthUrl, fetchThroughAuthProxy, openAuthProxySignIn } from './authProxy'

function opaqueRedirect(): Response {
    return { type: 'opaqueredirect', status: 0, ok: false } as Response
}

describe('fetchThroughAuthProxy', () => {
    let originalFetch: typeof globalThis.fetch
    let fetchMock: ReturnType<typeof vi.fn>

    beforeEach(() => {
        originalFetch = globalThis.fetch
        fetchMock = vi.fn()
        globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
    })

    afterEach(() => {
        globalThis.fetch = originalFetch
    })

    it('returns a normal response as is and asks for a manual redirect', async () => {
        const response = { type: 'basic', status: 200, ok: true } as Response
        fetchMock.mockResolvedValueOnce(response)

        await expect(fetchThroughAuthProxy('/api/auth')).resolves.toBe(response)
        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'manual' })
    })

    it('keeps the caller init, including its abort signal, on the first request', async () => {
        fetchMock.mockResolvedValueOnce({ type: 'basic', status: 200, ok: true } as Response)
        const signal = new AbortController().signal

        await fetchThroughAuthProxy('/api/sessions/s/export', { method: 'GET', signal })
        const firstInit = fetchMock.mock.calls[0][1] as RequestInit
        expect(firstInit.signal).toBe(signal)
        expect(firstInit).toMatchObject({ method: 'GET', redirect: 'manual' })
    })

    it('retries an opaqueredirect with the caller init and returns the retry response', async () => {
        const retry = { type: 'basic', status: 200, ok: true } as Response
        fetchMock.mockResolvedValueOnce(opaqueRedirect()).mockResolvedValueOnce(retry)

        const init: RequestInit = { method: 'POST', headers: { 'content-type': 'application/json' } }
        await expect(fetchThroughAuthProxy('https://h.example/api/auth', init)).resolves.toBe(retry)
        expect(fetchMock).toHaveBeenCalledTimes(2)
        expect(fetchMock.mock.calls[1][1]).toBe(init)
        expect(fetchMock.mock.calls[1][1]).not.toHaveProperty('redirect')
    })

    it('throws AuthProxyRedirectError when the retry rejects with a TypeError', async () => {
        fetchMock
            .mockResolvedValueOnce(opaqueRedirect())
            .mockRejectedValueOnce(new TypeError('Failed to fetch'))

        const error = await fetchThroughAuthProxy('https://h.example/api/auth').catch((e) => e)
        expect(error).toBeInstanceOf(AuthProxyRedirectError)
        expect(error.name).toBe('AuthProxyRedirectError')
        expect(error.hubOrigin).toBe('https://h.example')
    })

    it('uses window.location.origin for a relative input', async () => {
        fetchMock
            .mockReset()
            .mockResolvedValueOnce(opaqueRedirect())
            .mockRejectedValueOnce(new TypeError('Failed to fetch'))

        const error = await fetchThroughAuthProxy('/api/auth').catch((e) => e)
        expect(error).toBeInstanceOf(AuthProxyRedirectError)
        expect(error.hubOrigin).toBe(window.location.origin)
    })

    it('propagates a non-TypeError rejection from the retry unchanged', async () => {
        const failure = new RangeError('boom')
        fetchMock.mockResolvedValueOnce(opaqueRedirect()).mockRejectedValueOnce(failure)

        await expect(fetchThroughAuthProxy('/api/auth')).rejects.toBe(failure)
    })

    it('propagates a first-call rejection unchanged without retrying', async () => {
        const failure = new TypeError('Failed to fetch')
        fetchMock.mockRejectedValueOnce(failure)

        await expect(fetchThroughAuthProxy('/api/auth')).rejects.toBe(failure)
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })
})

describe('buildAuthProxyReauthUrl', () => {
    it('builds a cache-busting reauth url on the hub origin', () => {
        expect(buildAuthProxyReauthUrl('https://h.example', 123)).toBe('https://h.example/?hapi_reauth=123')
    })
})

describe('openAuthProxySignIn', () => {
    it('assigns in place when the hub is the current origin', () => {
        const assign = vi.fn()
        const open = vi.fn()
        const win = { location: { origin: 'https://app.example', assign }, open } as unknown as Window

        openAuthProxySignIn('https://app.example', win)

        expect(assign).toHaveBeenCalledTimes(1)
        expect(assign.mock.calls[0][0]).toMatch(/^https:\/\/app\.example\/\?hapi_reauth=\d+$/)
        expect(open).not.toHaveBeenCalled()
    })

    it('opens a new tab when the hub is a different origin', () => {
        const assign = vi.fn()
        const open = vi.fn()
        const win = { location: { origin: 'https://app.example', assign }, open } as unknown as Window

        openAuthProxySignIn('https://hub.example', win)

        expect(open).toHaveBeenCalledTimes(1)
        expect(open.mock.calls[0][0]).toMatch(/^https:\/\/hub\.example\/\?hapi_reauth=\d+$/)
        expect(open.mock.calls[0][1]).toBe('_blank')
        expect(open.mock.calls[0][2]).toBe('noopener,noreferrer')
        expect(assign).not.toHaveBeenCalled()
    })
})
