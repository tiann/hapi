// @vitest-environment-options { "url": "http://hub.test/" }
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuthSource } from './useAuthSource'

const ACCESS_TOKEN_KEY = 'hapi_access_token::http://hub.test'

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' }
    })
}

function mockFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
    const fn = vi.fn(handler)
    vi.stubGlobal('fetch', fn)
    return fn
}

function deferredResponse(): { promise: Promise<Response>; resolve: (res: Response) => void } {
    let resolve!: (res: Response) => void
    const promise = new Promise<Response>((res) => { resolve = res })
    return { promise, resolve }
}

function setTelegramEnvironment(active: boolean): void {
    if (active) {
        window.location.hash = '#tgWebAppVersion=1&tgWebAppPlatform=web'
    } else {
        window.location.hash = ''
    }
}

describe('useAuthSource — Cloudflare Access discovery', () => {
    beforeEach(() => {
        localStorage.clear()
        setTelegramEnvironment(false)
        window.history.pushState({}, '', '/')
    })

    afterEach(() => {
        vi.unstubAllGlobals()
        vi.useRealTimers()
    })

    it('signs in automatically when the same-origin hub reports the capability', async () => {
        const fetchMock = mockFetch(async (url) => {
            expect(url).toBe('http://hub.test/api/auth/methods')
            return jsonResponse({ cloudflareAccess: true })
        })

        const { result } = renderHook(() => useAuthSource('http://hub.test'))

        await waitFor(() => expect(result.current.authSource).toEqual({ type: 'cloudflareAccess' }))
        expect(result.current.isLoading).toBe(false)
        expect(result.current.isTelegram).toBe(false)
        expect(fetchMock).toHaveBeenCalledTimes(1)
        // No long-lived secret is persisted by the Cloudflare flow.
        expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBeNull()
    })

    it('falls back to manual login when the hub predates the methods endpoint (404)', async () => {
        mockFetch(async () => jsonResponse({ error: 'Not Found' }, 404))

        const { result } = renderHook(() => useAuthSource('http://hub.test'))

        await waitFor(() => expect(result.current.isLoading).toBe(false))
        expect(result.current.authSource).toBeNull()
    })

    it('falls back to manual login when the capability is disabled', async () => {
        mockFetch(async () => jsonResponse({ cloudflareAccess: false }))

        const { result } = renderHook(() => useAuthSource('http://hub.test'))

        await waitFor(() => expect(result.current.isLoading).toBe(false))
        expect(result.current.authSource).toBeNull()
    })

    it('falls back to manual login on network failure', async () => {
        mockFetch(async () => { throw new Error('network down') })

        const { result } = renderHook(() => useAuthSource('http://hub.test'))

        await waitFor(() => expect(result.current.isLoading).toBe(false))
        expect(result.current.authSource).toBeNull()
    })

    it('never discovers Cloudflare for a cross-origin hub', async () => {
        const fetchMock = mockFetch(async () => jsonResponse({ cloudflareAccess: true }))

        const { result } = renderHook(() => useAuthSource('http://other-origin.test'))

        await waitFor(() => expect(result.current.isLoading).toBe(false))
        expect(result.current.authSource).toBeNull()
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('bounds discovery to 5s and then shows manual login', async () => {
        vi.useFakeTimers()
        try {
            mockFetch((_url, init) => new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
            }))

            const { result } = renderHook(() => useAuthSource('http://hub.test'))
            expect(result.current.isLoading).toBe(true)

            await act(async () => {
                await vi.advanceTimersByTimeAsync(5_000)
            })

            expect(result.current.isLoading).toBe(false)
            expect(result.current.authSource).toBeNull()
        } finally {
            vi.useRealTimers()
        }
    })

    it('ignores a stale discovery result after the hub URL changes', async () => {
        const deferred = deferredResponse()
        mockFetch(async () => deferred.promise)

        const { result, rerender } = renderHook(
            ({ baseUrl }) => useAuthSource(baseUrl),
            { initialProps: { baseUrl: 'http://hub.test' } }
        )
        expect(result.current.isLoading).toBe(true)

        rerender({ baseUrl: 'http://other-origin.test' })
        await waitFor(() => expect(result.current.isLoading).toBe(false))
        expect(result.current.authSource).toBeNull()

        // The stale response arrives only after the re-render settled.
        deferred.resolve(jsonResponse({ cloudflareAccess: true }))
        await act(async () => { await Promise.resolve() })
        expect(result.current.authSource).toBeNull()
    })

    it('prefers Telegram initData over Cloudflare discovery', async () => {
        setTelegramEnvironment(true)
        window.history.pushState({}, '', '/?tgWebAppData=tg-init-data')
        mockFetch(async () => jsonResponse({ cloudflareAccess: true }))

        const { result } = renderHook(() => useAuthSource('http://hub.test'))

        await waitFor(() => expect(result.current.authSource).toEqual({ type: 'telegram', initData: 'tg-init-data' }))
        expect(result.current.isTelegram).toBe(true)
    })

    it('prefers delayed Telegram initData even when Cloudflare discovery resolves first', async () => {
        vi.useFakeTimers()
        try {
            setTelegramEnvironment(true)
            mockFetch(async () => jsonResponse({ cloudflareAccess: true }))

            const { result } = renderHook(() => useAuthSource('http://hub.test'))
            expect(result.current.isLoading).toBe(true)

            // Cloudflare discovery resolves first and must not commit yet.
            await act(async () => {
                await vi.advanceTimersByTimeAsync(100)
            })
            expect(result.current.authSource).toBeNull()

            // Delayed Telegram initData then arrives and wins.
            act(() => {
                window.history.pushState({}, '', '/?tgWebAppData=late-init-data')
            })
            await act(async () => {
                await vi.advanceTimersByTimeAsync(300)
            })

            expect(result.current.authSource).toEqual({ type: 'telegram', initData: 'late-init-data' })
            expect(result.current.isTelegram).toBe(true)
            expect(result.current.isLoading).toBe(false)
        } finally {
            vi.useRealTimers()
        }
    })

    it('keeps Telegram when its initData arrives before Cloudflare discovery resolves', async () => {
        setTelegramEnvironment(true)
        window.history.pushState({}, '', '/?tgWebAppData=tg-init-data')
        const deferred = deferredResponse()
        mockFetch(async () => deferred.promise)

        const { result } = renderHook(() => useAuthSource('http://hub.test'))
        await waitFor(() => expect(result.current.authSource).toEqual({ type: 'telegram', initData: 'tg-init-data' }))

        // A late Cloudflare discovery result must not override Telegram.
        deferred.resolve(jsonResponse({ cloudflareAccess: true }))
        await act(async () => { await Promise.resolve() })
        expect(result.current.authSource).toEqual({ type: 'telegram', initData: 'tg-init-data' })
    })

    it('falls back to Cloudflare when delayed Telegram polling exhausts without initData', async () => {
        vi.useFakeTimers()
        try {
            setTelegramEnvironment(true)
            mockFetch(async () => jsonResponse({ cloudflareAccess: true }))

            const { result } = renderHook(() => useAuthSource('http://hub.test'))
            expect(result.current.isLoading).toBe(true)

            // Let the full polling window (20 x 250ms) elapse with no initData.
            await act(async () => {
                await vi.advanceTimersByTimeAsync(20 * 250)
            })

            expect(result.current.authSource).toEqual({ type: 'cloudflareAccess' })
            expect(result.current.isLoading).toBe(false)
        } finally {
            vi.useRealTimers()
        }
    })

    it('prefers an explicit URL token over Cloudflare discovery', async () => {
        window.history.pushState({}, '', '/?token=url-token')
        mockFetch(async () => jsonResponse({ cloudflareAccess: true }))

        const { result } = renderHook(() => useAuthSource('http://hub.test'))

        await waitFor(() => expect(result.current.authSource).toEqual({ type: 'accessToken', token: 'url-token' }))
        expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBe('url-token')
    })

    it('prefers a stored access token over Cloudflare discovery', async () => {
        localStorage.setItem(ACCESS_TOKEN_KEY, 'stored-token')
        mockFetch(async () => jsonResponse({ cloudflareAccess: true }))

        const { result } = renderHook(() => useAuthSource('http://hub.test'))

        await waitFor(() => expect(result.current.authSource).toEqual({ type: 'accessToken', token: 'stored-token' }))
    })

    it('preserves the delayed Telegram polling flow', async () => {
        vi.useFakeTimers()
        try {
            setTelegramEnvironment(true)
            mockFetch(async () => jsonResponse({ cloudflareAccess: false }))

            const { result } = renderHook(() => useAuthSource('http://hub.test'))
            expect(result.current.isLoading).toBe(true)
            expect(result.current.authSource).toBeNull()

            act(() => {
                window.history.pushState({}, '', '/?tgWebAppData=late-init-data')
            })
            await act(async () => {
                await vi.advanceTimersByTimeAsync(300)
            })

            expect(result.current.authSource).toEqual({ type: 'telegram', initData: 'late-init-data' })
            expect(result.current.isTelegram).toBe(true)
            expect(result.current.isLoading).toBe(false)
        } finally {
            vi.useRealTimers()
        }
    })
})
