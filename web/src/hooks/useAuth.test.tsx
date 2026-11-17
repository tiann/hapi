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

// Discovery may select a different Hub than the stale session on the login
// screen. Mask old credentials during render, not only in a later effect.
describe('useAuth — discovered Hub isolation', () => {
    const source = { type: 'accessToken' as const, token: 'old-secret' }
    it('never returns an old Hub token or client while switching to the discovered Hub', async () => {
        const snapshots: Array<{ hub: string; token: string | null }> = []
        const { result, rerender } = renderHook(({ hub, authSource }) => {
            const value = useAuth(authSource, hub)
            snapshots.push({ hub, token: value.token })
            return value
        }, { initialProps: { hub: 'https://old.test', authSource: source as typeof source | null } })
        await waitFor(() => expect(result.current.api).not.toBeNull())
        const oldToken = result.current.token
        const oldApi = result.current.api as unknown as ApiWithOptions
        rerender({ hub: 'https://discovered.test', authSource: null })
        expect(result.current.api).toBeNull()
        expect(result.current.token).toBeNull()
        expect(snapshots.filter((s) => s.hub === 'https://discovered.test').every((s) => s.token !== oldToken)).toBe(true)
        expect(oldApi.options?.getToken?.()).toBeNull()
        expect(await oldApi.options?.onUnauthorized?.()).toBeNull()
    })

    it('ignores a pending old Hub refresh after a new Hub has authenticated', async () => {
        const { result, rerender } = renderHook(({ hub, selected }) => useAuth(selected, hub), { initialProps: { hub: 'https://old.test', selected: source } })
        await waitFor(() => expect(result.current.api).not.toBeNull())
        const oldApi = result.current.api as unknown as ApiWithOptions
        let resolve!: (value: { token: string; user: { id: string } }) => void
        const delayed = new Promise<{ token: string; user: { id: string } }>((done) => { resolve = done })
        const spy = vi.spyOn(h.MockApiClient.prototype, 'authenticate').mockImplementationOnce(() => delayed)
        let refresh: unknown
        act(() => { refresh = oldApi.options?.onUnauthorized?.() })
        rerender({ hub: 'https://discovered.test', selected: { type: 'accessToken', token: 'new-secret' } })
        await waitFor(() => expect(result.current.api).not.toBeNull())
        const newToken = result.current.token
        await act(async () => { resolve({ token: 'stale-refresh', user: { id: 'old-user' } }); await refresh })
        expect(result.current.token).toBe(newToken)
        expect(oldApi.options?.getToken?.()).toBeNull()
        spy.mockRestore()
    })

    it('also isolates a new passkey account on the same Hub from the previous refresh', async () => {
        const first = { type: 'passkey' as const, session: 'first-account' }
        const second = { type: 'passkey' as const, session: 'second-account' }
        const snapshots: Array<{ session: string; token: string | null }> = []
        const { result, rerender } = renderHook(({ selected }) => {
            const value = useAuth(selected, 'https://hub.test')
            snapshots.push({ session: selected.session, token: value.token })
            return value
        }, { initialProps: { selected: first } })
        await waitFor(() => expect(result.current.api).not.toBeNull())
        const oldToken = result.current.token
        const oldApi = result.current.api as unknown as ApiWithOptions
        let resolve!: (value: { token: string; user: { id: string } }) => void
        const delayed = new Promise<{ token: string; user: { id: string } }>((done) => { resolve = done })
        const spy = vi.spyOn(h.MockApiClient.prototype, 'authenticate').mockImplementationOnce(() => delayed)
        let refresh: unknown
        act(() => { refresh = oldApi.options?.onUnauthorized?.() })
        rerender({ selected: second })
        await waitFor(() => expect(result.current.api).not.toBeNull())
        const newToken = result.current.token
        expect(snapshots.filter((s) => s.session === second.session).every((s) => s.token !== oldToken)).toBe(true)
        expect(await oldApi.options?.onUnauthorized?.()).toBeNull()
        await act(async () => { resolve({ token: 'old-account-refresh', user: { id: 'old' } }); await refresh })
        expect(result.current.token).toBe(newToken)
        spy.mockRestore()
    })

})
