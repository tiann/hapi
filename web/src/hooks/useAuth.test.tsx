import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AUTH_PROXY_REDIRECT_MESSAGE, AuthProxyRedirectError } from '@/api/authProxy'

// Mock the network layer so we can drive token refreshes deterministically.
// The real ApiClient reads the live token via `getToken`, so the mock records the
// constructor options (including onUnauthorized) and hands out incrementing tokens.
const h = vi.hoisted(() => {
    let idSeq = 0
    let authCount = 0
    let authenticateImpl: ((count: number) => Promise<{ token: string; user: { id: string } }>) | null = null
    class MockApiClient {
        token: string
        options: { getToken?: () => string | null; onUnauthorized?: () => unknown; baseUrl?: string } | undefined
        readonly id: number
        constructor(token: string, options?: MockApiClient['options']) {
            this.token = token
            this.options = options
            this.id = ++idSeq
        }
        async authenticate(): Promise<{ token: string; user: { id: string } }> {
            authCount += 1
            if (authenticateImpl) {
                return authenticateImpl(authCount)
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
            impl: ((count: number) => Promise<{ token: string; user: { id: string } }>) | null
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
})
