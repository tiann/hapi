import { createElement, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ApiClient } from '@/api/client'
import type { Session } from '@/types/api'
import { observeSessionDetail, readSessionWithLiveUpdates } from '@/lib/sessionDetailRead'
import { queryKeys } from '@/lib/query-keys'
import { describe, expect, it, vi } from 'vitest'
import { useSession, isSessionNotFoundError, SESSION_DETAIL_STALE_TIME_MS } from './useSession'

describe('isSessionNotFoundError', () => {
    it('matches hub 404 session responses', () => {
        expect(isSessionNotFoundError(new Error('HTTP 404 Not Found: {"error":"Session not found"}'))).toBe(true)
    })

    it('does not match unrelated errors', () => {
        expect(isSessionNotFoundError(new Error('HTTP 500 Internal Server Error'))).toBe(false)
        expect(isSessionNotFoundError(null)).toBe(false)
    })
})

describe('SESSION_DETAIL_STALE_TIME_MS', () => {
    // SSE patches the cache directly on session-updated events, so the REST
    // endpoint is just a cold-start / reconnect-recovery path.  A long staleTime
    // suppresses focus-refetch and remount-refetch storms — primary lever for
    // the refetch-storm fix (tiann/hapi#884).
    it('is set to a value that suppresses focus/mount refetches', () => {
        expect(SESSION_DETAIL_STALE_TIME_MS).toBeGreaterThanOrEqual(10_000)
    })
})

it('checks a cached disconnected session on entry and keeps a newer reconnect during the fetch', async () => {
    const client = new QueryClient()
    const key = queryKeys.session('test')
    const offline = { id: 'test', active: false, activeAt: 10, thinking: false, thinkingAt: 10, metadataVersion: 0, metadata: null } as Session
    client.setQueryData(key, { session: offline })
    let resolve!: (value: { session: Session }) => void
    const getSession = vi.fn(() => new Promise<{ session: Session }>(done => { resolve = done }))
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)
    const view = renderHook(() => useSession({ getSession } as unknown as ApiClient, 'test'), { wrapper })
    expect(view.result.current.isFetching).toBe(true)
    expect(getSession).toHaveBeenCalledTimes(1)
    await act(async () => {
        observeSessionDetail(client, 'test', { active: true, thinking: true, activeAt: 20 })
        client.setQueryData(key, { session: { ...offline, active: true, thinking: true, thinkingAt: 20, activeAt: 20 } })
        resolve({ session: { ...offline, activeTurnStartedAt: 15 } })
    })
    await waitFor(() => expect(view.result.current.isFetching).toBe(false))
    expect(view.result.current.session).toMatchObject({ active: true, thinking: true, activeAt: 20, activeTurnStartedAt: 15 })
    view.unmount()
    client.clear()
})

it('preserves an archive metadata patch even when its liveness clock is unchanged', async () => {
    const client = new QueryClient()
    const key = queryKeys.session('archive-race')
    const offline = { id: 'archive-race', active: false, activeAt: 10, metadataVersion: 1, metadata: null } as Session
    client.setQueryData(key, { session: offline })
    let resolve!: (value: { session: Session }) => void
    const api = { getSession: () => new Promise(done => { resolve = done }) } as unknown as ApiClient
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)
    const view = renderHook(() => useSession(api, 'archive-race'), { wrapper })
    await act(async () => {
        client.setQueryData(key, { session: { ...offline, metadataVersion: 2, metadata: { lifecycleState: 'archived' } } })
        resolve({ session: offline })
    })
    await waitFor(() => expect(view.result.current.isFetching).toBe(false))
    expect(view.result.current.session).toMatchObject({ metadataVersion: 2, metadata: { lifecycleState: 'archived' } })
    view.unmount()
    client.clear()
})

it.each([true, false])('keeps equal-time expiry over a live snapshot (cached active=%s)', async cachedActive => {
    const client = new QueryClient()
    const key = queryKeys.session('expiry')
    const active = { id: 'expiry', active: true, activeAt: 10, thinking: true, metadataVersion: 0 } as Session
    client.setQueryData(key, { session: { ...active, active: cachedActive } }, { updatedAt: 1 })
    let resolve!: (value: { session: Session }) => void
    const getSession = vi.fn().mockImplementationOnce(() => new Promise(done => { resolve = done }))
        .mockResolvedValue({ session: { ...active, active: false, thinking: false, activeTurnStartedAt: null } })
    const api = { getSession } as unknown as ApiClient
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)
    const view = renderHook(() => useSession(api, 'expiry'), { wrapper })
    await act(async () => {
        observeSessionDetail(client, 'expiry', { active: false, activeAt: 10, thinking: false, activeTurnStartedAt: null })
        client.setQueryData(key, { session: { ...active, active: false, thinking: false } })
        resolve({ session: { ...active, activeTurnStartedAt: 9 } })
    })
    await waitFor(() => expect(view.result.current.isFetching).toBe(false))
    expect(view.result.current.session).toMatchObject({ active: false, thinking: false, activeAt: 10, activeTurnStartedAt: null })
    expect(getSession).toHaveBeenCalledTimes(2)
    view.unmount()
    client.clear()
})

it('does not resurrect a stopped session from its pre-expiry heartbeat replay', async () => {
    const client = new QueryClient()
    const key = queryKeys.session('replay')
    const offline = { id: 'replay', active: false, activeAt: 10, thinking: false, metadataVersion: 0 } as Session
    client.setQueryData(key, { session: offline })
    let resolve!: (value: { session: Session }) => void
    const getSession = vi.fn().mockImplementationOnce(() => new Promise(done => { resolve = done })).mockResolvedValue({ session: offline })
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)
    const view = renderHook(() => useSession({ getSession } as unknown as ApiClient, 'replay'), { wrapper })
    await act(async () => { observeSessionDetail(client, 'replay', { active: true, thinking: true, activeAt: 10 }); resolve({ session: offline }) })
    await waitFor(() => expect(view.result.current.isFetching).toBe(false))
    expect(getSession).toHaveBeenCalledTimes(2)
    expect(view.result.current.session).toMatchObject({ active: false, thinking: false })
    view.unmount(); client.clear()
})

it('does not let a replayed queued-turn event reopen a stopped turn', async () => {
    const client = new QueryClient()
    const result = await readSessionWithLiveUpdates(client, 'stopped', async () => {
        observeSessionDetail(client, 'stopped', { thinking: true, activeTurnStartedAt: 1, updatedAt: 1 })
        return { session: { id: 'stopped', active: false, activeAt: 1, thinking: false, activeTurnStartedAt: null } as Session }
    })
    expect(result.session).toMatchObject({ active: false, thinking: false, activeTurnStartedAt: null })
})

it('verifies a connected idle snapshot after a delayed queued-turn patch, even on repeated replay', async () => {
    const client = new QueryClient()
    const idle = { id: 'idle', active: true, activeAt: 10, thinking: false, activeTurnStartedAt: null } as Session
    const read = vi.fn(async () => {
        observeSessionDetail(client, 'idle', { thinking: true, activeTurnStartedAt: 9, updatedAt: 9 })
        return { session: idle }
    })
    const result = await readSessionWithLiveUpdates(client, 'idle', read)
    expect(read).toHaveBeenCalledTimes(2)
    expect(result.session).toMatchObject({ active: true, thinking: false, activeTurnStartedAt: null })
})
