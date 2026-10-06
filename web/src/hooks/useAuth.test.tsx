import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

// Mock the network layer so we can drive token refreshes deterministically.
// The real ApiClient reads the live token via `getToken`, so the mock records the
// constructor options (including onUnauthorized) and hands out incrementing tokens.
const h = vi.hoisted(() => {
    let idSeq = 0
    let authCount = 0
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
            return { token: `token-${authCount}`, user: { id: 'u1' } }
        }
        async authenticateWithCloudflare(): Promise<{ token: string; user: { id: string } }> {
            authCount += 1
            return { token: `cf-token-${authCount}`, user: { id: 'u1' } }
        }
        async getAuthMethods(): Promise<{ cloudflareAccess: boolean }> {
            return { cloudflareAccess: true }
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
    return { MockApiClient, MockApiError }
})

vi.mock('@/api/client', () => ({ ApiClient: h.MockApiClient, ApiError: h.MockApiError }))

// Imported after the mock is registered (vi.mock is hoisted).
import { useAuth } from '@/hooks/useAuth'

type ApiWithOptions = {
    id: number
    options?: { getToken?: () => string | null; onUnauthorized?: () => unknown }
}

function fakeJwt(payload: Record<string, unknown>): string {
    const encode = (value: unknown) => btoa(JSON.stringify(value))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
    return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.signature`
}

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

    it('uses the Cloudflare GET for initial auth and every refresh when the source is active', async () => {
        const authSource = { type: 'cloudflareAccess' as const }
        const { result } = renderHook(() => useAuth(authSource, 'http://hub.test'))

        await waitFor(() => expect(result.current.api).not.toBeNull())
        const api1 = result.current.api as unknown as ApiWithOptions
        const token1 = result.current.token
        expect(token1).toMatch(/^cf-token-\d+$/)

        // A 401-driven refresh must also use the Cloudflare GET, not the POST.
        await act(async () => {
            await api1.options?.onUnauthorized?.()
        })
        expect(result.current.token).toMatch(/^cf-token-\d+$/)
        expect(result.current.token).not.toBe(token1)
        expect(api1.options?.getToken?.()).toBe(result.current.token)
        expect(result.current.api).toBe(api1 as unknown as typeof result.current.api)
    })

    it('surfaces Cloudflare auth failures as errors without clearing the source', async () => {
        const { MockApiClient: MockClient, MockApiError: MockError } = h
        const spy = vi.spyOn(MockClient.prototype, 'authenticateWithCloudflare')
            .mockRejectedValue(new MockError('Auth failed: HTTP 401', 401))
        try {
            const authSource = { type: 'cloudflareAccess' as const }
            const { result } = renderHook(() => useAuth(authSource, 'http://hub.test'))

            await waitFor(() => expect(result.current.error).toBe('Auth failed: HTTP 401'))
            expect(result.current.token).toBeNull()
            expect(result.current.isLoading).toBe(false)
        } finally {
            spy.mockRestore()
        }
    })

    it('bounds scheduled Cloudflare refreshes to 15s with fixed-exp changing tokens', async () => {
        vi.useFakeTimers()
        try {
            const { MockApiClient: MockClient } = h
            let cfCalls = 0
            const seenTokens: string[] = []
            const spy = vi.spyOn(MockClient.prototype, 'authenticateWithCloudflare')
                .mockImplementation(async () => {
                    cfCalls += 1
                    const exp = Math.floor(Date.now() / 1000) + 30
                    const token = fakeJwt({ uid: 1, ns: 'default', authMethod: 'cloudflareAccess', exp })
                    seenTokens.push(token)
                    return { token, user: { id: 'u1' } }
                })

            const authSource = { type: 'cloudflareAccess' as const }
            const { result } = renderHook(() => useAuth(authSource, 'http://hub.test'))

            await act(async () => {
                await vi.advanceTimersByTimeAsync(0)
            })
            expect(cfCalls).toBe(1)
            expect(result.current.token).toBe(seenTokens[0])

            // No scheduled refresh may fire before the 15s floor.
            await act(async () => {
                await vi.advanceTimersByTimeAsync(14_000)
            })
            expect(cfCalls).toBe(1)

            // Exactly one refresh per 15s window, each with a changed token.
            await act(async () => {
                await vi.advanceTimersByTimeAsync(1_000)
            })
            expect(cfCalls).toBe(2)
            expect(result.current.token).toBe(seenTokens[1])
            expect(result.current.token).not.toBe(seenTokens[0])

            await act(async () => {
                await vi.advanceTimersByTimeAsync(14_000)
            })
            expect(cfCalls).toBe(2)

            await act(async () => {
                await vi.advanceTimersByTimeAsync(1_000)
            })
            expect(cfCalls).toBe(3)
            expect(result.current.token).toBe(seenTokens[2])

            spy.mockRestore()
        } finally {
            vi.useRealTimers()
        }
    })

    it('keeps legacy scheduling immediate for short-lived tokens', async () => {
        vi.useFakeTimers()
        try {
            const { MockApiClient: MockClient } = h
            let authCalls = 0
            const spy = vi.spyOn(MockClient.prototype, 'authenticate')
                .mockImplementation(async () => {
                    authCalls += 1
                    const exp = Math.floor(Date.now() / 1000) + 30
                    return { token: fakeJwt({ uid: 1, ns: 'default', exp }), user: { id: 'u1' } }
                })

            const authSource = { type: 'accessToken' as const, token: 'seed' }
            renderHook(() => useAuth(authSource, 'http://hub.test'))

            await act(async () => {
                await vi.advanceTimersByTimeAsync(0)
            })
            expect(authCalls).toBe(1)

            // Legacy tokens keep the original exp-60s schedule with no floor:
            // a 30s-exp token refreshes as soon as the zero-delay timer fires.
            await act(async () => {
                await vi.advanceTimersByTimeAsync(1_000)
            })
            expect(authCalls).toBe(2)

            spy.mockRestore()
        } finally {
            vi.useRealTimers()
        }
    })
})
