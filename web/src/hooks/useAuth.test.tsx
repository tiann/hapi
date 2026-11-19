import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AUTH_PROXY_REDIRECT_MESSAGE, AuthProxyRedirectError } from '@/api/authProxy'

// Mock the network layer so we can drive token refreshes deterministically.
// The real ApiClient reads the live token via `getToken`, so the mock records the
// constructor options (including onUnauthorized) and hands out incrementing tokens.
const h = vi.hoisted(() => {
    let idSeq = 0
    let authCount = 0
    let authenticateImpl: ((count: number, signal?: AbortSignal) => Promise<{ token: string; user: { id: string } }>) | null = null
    class MockApiClient {
        token: string
        options: { getToken?: () => string | null; onUnauthorized?: () => unknown; baseUrl?: string } | undefined
        readonly id: number
        constructor(token: string, options?: MockApiClient['options']) {
            this.token = token
            this.options = options
            this.id = ++idSeq
        }
        async authenticate(_payload?: unknown, options?: { signal?: AbortSignal }): Promise<{ token: string; user: { id: string } }> {
            authCount += 1
            if (authenticateImpl) {
                return authenticateImpl(authCount, options?.signal)
            }
            return { token: `token-${authCount}`, user: { id: 'u1' } }
        }
    }
    class MockApiError extends Error {
        status: number
        code?: string
        constructor(message: string, status = 401, code?: string) {
            super(message)
            this.status = status
            this.code = code
        }
    }
    return {
        MockApiClient,
        MockApiError,
        getAuthCount: () => authCount,
        resetAuth: () => {
            authCount = 0
            authenticateImpl = null
        },
        setAuthenticateImpl: (
            impl: ((count: number, signal?: AbortSignal) => Promise<{ token: string; user: { id: string } }>) | null
        ) => {
            authenticateImpl = impl
        }
    }
})

vi.mock('@/api/client', () => ({ ApiClient: h.MockApiClient, ApiError: h.MockApiError }))

// Imported after the mock is registered (vi.mock is hoisted).
import { useAuth } from '@/hooks/useAuth'

type ApiWithOptions = {
    id: number
    options?: { getToken?: () => string | null; onUnauthorized?: () => unknown }
}

function makeJwtWithExp(expSeconds: number): string {
    const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
    const payload = btoa(JSON.stringify({ exp: expSeconds }))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
    return `${header}.${payload}.sig`
}

async function flushMicrotasks(): Promise<void> {
    await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
    })
}

beforeEach(() => {
    h.resetAuth()
})

afterEach(() => {
    vi.useRealTimers()
    h.resetAuth()
})

describe('useAuth — api identity stability across token refresh (issue #927)', () => {
    it('keeps the same ApiClient instance when the token refreshes', async () => {
        // Stable authSource reference, exactly like the real caller (useAuthSource holds it in
        // useState). This isolates the bug under test: a *token* refresh, not a source change.
        const authSource = { type: 'accessToken' as const, token: 'seed' }
        const { result } = renderHook(() => useAuth(authSource, 'http://hub.test'))

        // Initial authenticate resolves and sets the first token.
        await waitFor(() => expect(result.current.api).not.toBeNull())
        const api1 = result.current.api as unknown as ApiWithOptions
        const token1 = result.current.token
        expect(token1).toBe('token-1')

        // Drive the exact real-world trigger: a 401 invokes onUnauthorized,
        // which force-refreshes the token (this is what the flaky remote network does).
        await act(async () => {
            await api1.options?.onUnauthorized?.()
        })

        // The token did advance...
        expect(result.current.token).toBe('token-2')
        expect(result.current.token).not.toBe(token1)

        // ...but recreating the client was unnecessary: the OLD instance already serves
        // the fresh token via getToken, so nothing downstream needed a new `api` reference.
        expect(api1.options?.getToken?.()).toBe(result.current.token)

        // DESIRED: `api` stays referentially stable across a refresh, so effects keyed on
        // `api` (VoiceBackendSession `[props.api]`, GeneratedImageCard `[ctx.api, ...]`) do
        // NOT re-run / remount. On current code `api` is rebuilt because `token` is a useMemo
        // dep, which drives the Voice-remount spam + per-image refetch storm. This fails today.
        expect(result.current.api).toBe(api1 as unknown as typeof result.current.api)
    })
})

describe('useAuth — weak-network and JWT expiry resilience', () => {
    it('preserves active session past JWT exp during transient network/5xx errors and recovers seamlessly', async () => {
        vi.useFakeTimers()
        const baseTimeMs = new Date('2026-01-01T00:00:00Z').getTime()
        vi.setSystemTime(baseTimeMs)

        const jwt1 = makeJwtWithExp(Math.floor(baseTimeMs / 1000) + 120)
        const jwt2 = makeJwtWithExp(Math.floor(baseTimeMs / 1000) + 14_400)
        let shouldFail = false
        let recoveredToken = false

        h.setAuthenticateImpl(async (count) => {
            if (count === 1) {
                return { token: jwt1, user: { id: 'u1' } }
            }
            if (shouldFail) {
                if (count % 2 === 0) {
                    throw new TypeError('Failed to fetch')
                }
                throw new h.MockApiError('Auth failed: HTTP 502 Bad Gateway', 502)
            }
            recoveredToken = true
            return { token: jwt2, user: { id: 'u1' } }
        })

        const authSource = { type: 'accessToken' as const, token: 'seed' }
        const { result } = renderHook(() => useAuth(authSource, 'http://hub.test'))
        await flushMicrotasks()

        expect(result.current.token).toBe(jwt1)
        expect(result.current.error).toBeNull()
        const initialApi = result.current.api
        expect(initialApi).not.toBeNull()

        shouldFail = true

        // 60s -> proactive refresh fires (exp - 60s) and fails with TypeError (t = 60s).
        await act(async () => {
            await vi.advanceTimersByTimeAsync(60_000)
        })
        expect(h.getAuthCount()).toBe(2)
        expect(result.current.token).toBe(jwt1)
        expect(result.current.error).toBeNull()

        // Bounded backoff steps (5s, 10s, 15s, 15s, 15s -> t = 120s = expMs), then keep retrying past expMs.
        for (const delayMs of [5_000, 10_000, 15_000, 15_000, 15_000]) {
            await act(async () => {
                await vi.advanceTimersByTimeAsync(delayMs)
            })
        }
        const attemptsAtExp = h.getAuthCount()
        expect(attemptsAtExp).toBe(7)
        expect(result.current.token).toBe(jwt1)
        expect(result.current.user).toEqual({ id: 'u1' })
        expect(result.current.error).toBeNull()
        expect(result.current.api).toBe(initialApi)

        // Continue failing 90s past JWT expMs (t = 210s): retries must NOT stop at expMs.
        for (const delayMs of [15_000, 15_000, 15_000, 15_000, 15_000, 15_000]) {
            await act(async () => {
                await vi.advanceTimersByTimeAsync(delayMs)
            })
        }
        expect(h.getAuthCount()).toBe(13)
        expect(result.current.token).toBe(jwt1)
        expect(result.current.error).toBeNull()
        expect(result.current.api).toBe(initialApi)

        // Network recovers on next scheduled retry (t = 225s, 105s past expMs).
        shouldFail = false
        await act(async () => {
            await vi.advanceTimersByTimeAsync(15_000)
        })

        expect(recoveredToken).toBe(true)
        expect(result.current.token).toBe(jwt2)
        expect(result.current.error).toBeNull()
        expect(result.current.api).toBe(initialApi)
    })

    it('clears active session and stops transient retries on definitive 401 rejection', async () => {
        vi.useFakeTimers()
        const baseTimeMs = new Date('2026-01-01T00:00:00Z').getTime()
        vi.setSystemTime(baseTimeMs)

        const jwt1 = makeJwtWithExp(Math.floor(baseTimeMs / 1000) + 300)
        h.setAuthenticateImpl(async (count) => {
            if (count === 1) {
                return { token: jwt1, user: { id: 'u1' } }
            }
            throw new h.MockApiError('Auth failed: HTTP 401 Unauthorized', 401)
        })

        const authSource = { type: 'accessToken' as const, token: 'seed' }
        const { result } = renderHook(() => useAuth(authSource, 'http://hub.test'))
        await flushMicrotasks()

        expect(result.current.token).toBe(jwt1)

        // Proactive refresh fires at 240s and receives definitive 401.
        await act(async () => {
            await vi.advanceTimersByTimeAsync(240_000)
        })

        expect(result.current.token).toBeNull()
        expect(result.current.user).toBeNull()
        expect(result.current.api).toBeNull()
        expect(result.current.error).toBe('Session expired. Please login again.')

        const countAfterReject = h.getAuthCount()
        await act(async () => {
            await vi.advanceTimersByTimeAsync(60_000)
        })
        expect(h.getAuthCount()).toBe(countAfterReject)
    })

    it('surfaces cold-load transient errors and recovers via backoff timer or online event', async () => {
        vi.useFakeTimers()
        const baseTimeMs = new Date('2026-01-01T00:00:00Z').getTime()
        vi.setSystemTime(baseTimeMs)

        const jwt1 = makeJwtWithExp(Math.floor(baseTimeMs / 1000) + 14_400)
        let shouldFail = true
        h.setAuthenticateImpl(async () => {
            if (shouldFail) {
                throw new TypeError('Failed to fetch')
            }
            return { token: jwt1, user: { id: 'u1' } }
        })

        const authSource = { type: 'accessToken' as const, token: 'seed' }
        const { result, unmount } = renderHook(() => useAuth(authSource, 'http://hub.test'))
        await flushMicrotasks()

        expect(result.current.token).toBeNull()
        expect(result.current.error).toBe('Failed to fetch')

        shouldFail = false
        await act(async () => {
            window.dispatchEvent(new Event('online'))
            await Promise.resolve()
        })

        expect(result.current.token).toBe(jwt1)
        expect(result.current.error).toBeNull()
        expect(result.current.api).not.toBeNull()
        unmount()

        // Also verify automatic backoff timer recovery without an online event.
        h.resetAuth()
        shouldFail = true
        h.setAuthenticateImpl(async (count) => {
            if (count === 1) {
                throw new TypeError('Failed to fetch')
            }
            return { token: jwt1, user: { id: 'u1' } }
        })

        const retryHook = renderHook(() => useAuth(authSource, 'http://hub.test'))
        await flushMicrotasks()
        expect(retryHook.result.current.token).toBeNull()
        expect(retryHook.result.current.error).toBe('Failed to fetch')

        await act(async () => {
            await vi.advanceTimersByTimeAsync(3_000)
        })

        expect(retryHook.result.current.token).toBe(jwt1)
        expect(retryHook.result.current.error).toBeNull()
    })

    it('does not schedule background retry polling on AuthProxyRedirectError', async () => {
        vi.useFakeTimers()
        h.setAuthenticateImpl(async () => {
            throw new AuthProxyRedirectError('http://hub.test')
        })

        const authSource = { type: 'accessToken' as const, token: 'seed' }
        const { result } = renderHook(() => useAuth(authSource, 'http://hub.test'))
        await flushMicrotasks()

        expect(result.current.token).toBeNull()
        expect(result.current.error).toBe(AUTH_PROXY_REDIRECT_MESSAGE)

        const countAfterRedirect = h.getAuthCount()
        await act(async () => {
            window.dispatchEvent(new Event('online'))
            await vi.advanceTimersByTimeAsync(60_000)
        })
        expect(h.getAuthCount()).toBe(countAfterRedirect)
    })

    it('refreshes via handleSseClosed immediately when JWT is expiring and respects 15s cooldown otherwise', async () => {
        vi.useFakeTimers()
        const baseTimeMs = new Date('2026-01-01T00:00:00Z').getTime()
        vi.setSystemTime(baseTimeMs)

        const longJwt = makeJwtWithExp(Math.floor(baseTimeMs / 1000) + 300)
        const shortJwt = makeJwtWithExp(Math.floor(baseTimeMs / 1000) + 50)
        const freshJwt = makeJwtWithExp(Math.floor(baseTimeMs / 1000) + 14_400)

        h.setAuthenticateImpl(async (count) => {
            if (count === 1) return { token: longJwt, user: { id: 'u1' } }
            if (count === 2) return { token: shortJwt, user: { id: 'u1' } }
            return { token: freshJwt, user: { id: 'u1' } }
        })

        const authSource = { type: 'accessToken' as const, token: 'seed' }
        const { result } = renderHook(() => useAuth(authSource, 'http://hub.test'))
        await flushMicrotasks()
        expect(h.getAuthCount()).toBe(1)

        // Healthy JWT + within 15s cooldown -> ignored
        await act(async () => {
            await vi.advanceTimersByTimeAsync(5_000)
            result.current.handleSseClosed()
            await Promise.resolve()
        })
        expect(h.getAuthCount()).toBe(1)

        // Past 15s cooldown -> refreshes even when JWT still has >60s TTL (e.g. rotated Hub secret)
        await act(async () => {
            await vi.advanceTimersByTimeAsync(15_000)
            result.current.handleSseClosed()
            await Promise.resolve()
        })
        expect(h.getAuthCount()).toBe(2)
        expect(result.current.token).toBe(shortJwt)

        // Only 500ms later, but shortJwt now has TTL = 30s (<= 60s) -> refreshes immediately
        await act(async () => {
            await vi.advanceTimersByTimeAsync(500)
            result.current.handleSseClosed()
            await Promise.resolve()
        })
        expect(h.getAuthCount()).toBe(3)
        expect(result.current.token).toBe(freshJwt)
    })

    it('returns null from stale refresh across hub/authSource switches without leaking replacement credentials', async () => {
        let resolveStaleRefresh!: (value: { token: string; user: { id: string } }) => void
        let rejectStaleRefresh!: (error: unknown) => void

        h.setAuthenticateImpl((count) => {
            if (count === 1) {
                return Promise.resolve({ token: 'token-hub-a-1', user: { id: 'u-a' } })
            }
            if (count === 2) {
                return new Promise((resolve) => {
                    resolveStaleRefresh = resolve
                })
            }
            if (count === 3) {
                return Promise.resolve({ token: 'token-hub-b-1', user: { id: 'u-b' } })
            }
            if (count === 4) {
                return new Promise((_resolve, reject) => {
                    rejectStaleRefresh = reject
                })
            }
            return Promise.resolve({ token: 'token-hub-c-1', user: { id: 'u-c' } })
        })

        const sourceA = { type: 'accessToken' as const, token: 'seed-a' }
        const sourceB = { type: 'accessToken' as const, token: 'seed-b' }
        const sourceC = { type: 'accessToken' as const, token: 'seed-c' }

        const { result, rerender } = renderHook(
            ({ source, hub }: { source: { type: 'accessToken'; token: string }; hub: string }) =>
                useAuth(source, hub),
            { initialProps: { source: sourceA, hub: 'http://hub-a.test' } }
        )
        await flushMicrotasks()

        const apiA = result.current.api as unknown as ApiWithOptions
        expect(result.current.token).toBe('token-hub-a-1')

        // Start a refresh on Hub A's client while it is still current.
        let staleResolveResult: unknown = 'pending'
        await act(async () => {
            const p = Promise.resolve(apiA.options?.onUnauthorized?.()).then((val) => {
                staleResolveResult = val
            })
            void p
            await Promise.resolve()
        })

        // Switch hub & authSource before Hub A's refresh resolves.
        rerender({ source: sourceB, hub: 'http://hub-b.test' })
        await flushMicrotasks()

        expect(result.current.token).toBe('token-hub-b-1')
        expect(apiA.options?.getToken?.()).toBeNull()

        // Hub A's delayed refresh settles AFTER Hub B is authenticated -> must return null, NEVER token-hub-b-1.
        await act(async () => {
            resolveStaleRefresh({ token: 'token-hub-a-late', user: { id: 'u-a' } })
            await Promise.resolve()
            await Promise.resolve()
        })
        expect(staleResolveResult).toBeNull()
        expect(result.current.token).toBe('token-hub-b-1')

        // Calling onUnauthorized on obsolete apiA after switch returns null without hitting authenticate.
        const countBeforeOldCall = h.getAuthCount()
        let lateCallResult: unknown = 'pending'
        await act(async () => {
            lateCallResult = await apiA.options?.onUnauthorized?.()
        })
        expect(lateCallResult).toBeNull()
        expect(h.getAuthCount()).toBe(countBeforeOldCall)

        // Also verify a rejecting stale refresh after switching authSource on the same hub returns null and preserves session C.
        const apiB = result.current.api as unknown as ApiWithOptions
        let staleRejectResult: unknown = 'pending'
        await act(async () => {
            const p = Promise.resolve(apiB.options?.onUnauthorized?.()).then((val) => {
                staleRejectResult = val
            })
            void p
            await Promise.resolve()
        })

        rerender({ source: sourceC, hub: 'http://hub-b.test' })
        await flushMicrotasks()
        expect(result.current.token).toBe('token-hub-c-1')

        await act(async () => {
            rejectStaleRefresh(new h.MockApiError('Auth failed: HTTP 401 Unauthorized', 401))
            await Promise.resolve()
            await Promise.resolve()
        })
        expect(staleRejectResult).toBeNull()
        expect(result.current.token).toBe('token-hub-c-1')
        expect(result.current.error).toBeNull()
    })

    it('honors transient retry backoff across repeated handleSseClosed calls when JWT is expiring', async () => {
        vi.useFakeTimers()
        const baseTimeMs = new Date('2026-01-01T00:00:00Z').getTime()
        vi.setSystemTime(baseTimeMs)

        const expiringJwt = makeJwtWithExp(Math.floor(baseTimeMs / 1000) + 45)
        const freshJwt = makeJwtWithExp(Math.floor(baseTimeMs / 1000) + 14_400)
        let shouldFail = false

        h.setAuthenticateImpl(async (count) => {
            if (count === 1) {
                return { token: expiringJwt, user: { id: 'u1' } }
            }
            if (shouldFail) {
                throw new h.MockApiError('Auth failed: HTTP 502 Bad Gateway', 502)
            }
            return { token: freshJwt, user: { id: 'u1' } }
        })

        const authSource = { type: 'accessToken' as const, token: 'seed' }
        const { result } = renderHook(() => useAuth(authSource, 'http://hub.test'))
        await flushMicrotasks()
        expect(h.getAuthCount()).toBe(1)

        // First SSE closure when JWT has <=60s remaining triggers immediate recovery attempt,
        // which fails transiently and arms the 5_000ms backoff window.
        shouldFail = true
        await act(async () => {
            result.current.handleSseClosed()
            await Promise.resolve()
        })
        expect(h.getAuthCount()).toBe(2)

        // Repeated SSE closures during the 5_000ms transient backoff window are suppressed.
        for (const stepMs of [200, 1_000, 2_000]) {
            await act(async () => {
                await vi.advanceTimersByTimeAsync(stepMs)
                result.current.handleSseClosed()
                await Promise.resolve()
            })
            expect(h.getAuthCount()).toBe(2)
        }

        // Reaching t = 5_000ms fires the scheduled retry (arming the 10_000ms window).
        await act(async () => {
            await vi.advanceTimersByTimeAsync(1_800)
        })
        expect(h.getAuthCount()).toBe(3)

        // Repeated SSE closures during the 10_000ms backoff window are suppressed as well.
        for (const stepMs of [3_000, 4_000]) {
            await act(async () => {
                await vi.advanceTimersByTimeAsync(stepMs)
                result.current.handleSseClosed()
                await Promise.resolve()
            })
            expect(h.getAuthCount()).toBe(3)
        }

        // Recovery succeeds when the 10_000ms backoff timer completes (t = 15_000ms).
        shouldFail = false
        await act(async () => {
            await vi.advanceTimersByTimeAsync(3_000)
        })
        expect(h.getAuthCount()).toBe(4)
        expect(result.current.token).toBe(freshJwt)
        expect(result.current.error).toBeNull()
    })
})

describe('useAuth connection failure classification', () => {
    it.each(['network', 'server', 'rejected'])('separates %s failures from invalid saved credentials', async kind => {
        const failure = kind === 'network' ? new TypeError('Failed to fetch') : new h.MockApiError('Unavailable', kind === 'server' ? 503 : 401)
        h.setAuthenticateImpl(async () => { throw failure })
        const source = { type: 'accessToken' as const, token: 'saved-fixture-credential' }
        const { result } = renderHook(() => useAuth(source, 'https://hub.test'))
        await waitFor(() => expect(result.current.isLoading).toBe(false))
        expect(result.current.token).toBeNull()
        expect(result.current.connectionError).toEqual(kind === 'rejected' ? null : kind === 'server' ? { status: 503 } : {})
        if (kind === 'rejected') return
        h.setAuthenticateImpl(async () => ({ token: 'recovered-token', user: { id: 'u1' } }))
        act(() => result.current.retryConnection())
        await waitFor(() => expect(result.current.token).toBe('recovered-token'))
        expect(result.current.connectionError).toBeNull()
        expect(result.current.error).toBeNull()
    })
    it('does not carry a connection failure to another hub or auth source', async () => {
        h.setAuthenticateImpl(async () => { throw new TypeError('Failed to fetch') })
        const oldSource = { type: 'accessToken' as const, token: 'old-fixture-credential' }
        const { result, rerender } = renderHook(({ source, base }) => useAuth(source, base), { initialProps: { source: oldSource, base: 'https://old.test' } })
        await waitFor(() => expect(result.current.connectionError).toEqual({}))
        h.setAuthenticateImpl(() => new Promise(() => {}))
        rerender({ source: { type: 'accessToken', token: 'new-fixture-credential' }, base: 'https://new.test' })
        expect(result.current.connectionError).toBeNull()
        expect(result.current.api).toBeNull()
    })
})

it('bounds a stalled authentication attempt and treats its timeout as a connection failure', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    h.setAuthenticateImpl((_count, current) => new Promise((_resolve, reject) => {
        signal = current
        current?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    }))
    const source = { type: 'accessToken' as const, token: 'fixture' }
    const { result, unmount } = renderHook(() => useAuth(source, 'https://hub.test'))
    await flushMicrotasks()
    expect(result.current.isLoading).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    expect(signal?.aborted).toBe(true)
    expect(result.current.isLoading).toBe(false)
    expect(result.current.connectionError).toEqual({})
    expect(result.current.token).toBeNull()
    unmount()
})
it('cancels a stalled automatic attempt when Retry now is requested', async () => {
    vi.useFakeTimers()
    let stalled: AbortSignal | undefined
    h.setAuthenticateImpl((count, signal) => {
        if (count === 1) return Promise.reject(new h.MockApiError('Unavailable', 503))
        if (count === 2) return new Promise((_resolve, reject) => {
            stalled = signal
            signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
        })
        return Promise.resolve({ token: 'recovered-token', user: { id: 'u1' } })
    })
    const source = { type: 'accessToken' as const, token: 'fixture' }
    const { result, unmount } = renderHook(() => useAuth(source, 'https://hub.test'))
    await flushMicrotasks()
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
    expect(h.getAuthCount()).toBe(2)
    act(() => result.current.retryConnection())
    await flushMicrotasks()
    expect(stalled?.aborted).toBe(true)
    expect(h.getAuthCount()).toBe(3)
    expect(result.current.token).toBe('recovered-token')
    expect(result.current.connectionError).toBeNull()
    unmount()
})
it('keeps the explicit Telegram-disabled diagnostic actionable', async () => {
    const diagnostic = 'Telegram authentication is disabled. Configure TELEGRAM_BOT_TOKEN.'
    h.setAuthenticateImpl(async () => { throw new h.MockApiError('Unavailable', 503, diagnostic) })
    const source = { type: 'telegram' as const, initData: 'fixture' }
    const { result } = renderHook(() => useAuth(source, 'https://hub.test'))
    await waitFor(() => expect(result.current.connectionError?.diagnostic).toBe(diagnostic))
})
