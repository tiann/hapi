import { createElement, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { SessionResponse, SessionSummary } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import { useSession } from './useSession'

afterEach(cleanup)

/** A view=slim list row as `useSessions` stores it: detail-only fields and
 *  empty-default fields absent from the wire. */
const slimRow = {
    id: 's1',
    updatedAt: 5000,
    createdAt: 4000,
    lastUserMessageAt: 4900,
    active: true,
    contentRevision: 9,
    metadataVersion: 5,
    agentStateVersion: 6,
    todosUpdatedAt: 7,
    metadata: {
        path: '/work/proj',
        name: 'Seeded title',
        flavor: 'codex',
        machineId: 'mac-1',
        agentSessionId: 'codex-thread-9'
    }
} as unknown as SessionSummary

function detailResponse(overrides: Partial<SessionResponse['session']> = {}): SessionResponse {
    return {
        session: {
            id: 's1',
            namespace: 'default',
            seq: 42,
            createdAt: 4000,
            updatedAt: 5100,
            active: true,
            activeAt: 5050,
            metadata: {
                path: '/work/proj',
                host: 'macbook',
                name: 'Real title',
                flavor: 'codex',
                machineId: 'mac-1',
                codexSessionId: 'codex-thread-9'
            },
            metadataVersion: 5,
            agentState: { requests: {} },
            agentStateVersion: 6,
            thinking: true,
            thinkingAt: 5050,
            contentRevision: 5,
            ...overrides
        } as SessionResponse['session']
    }
}

function setup(sessions: SessionSummary[] | undefined) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    if (sessions) {
        client.setQueryData(queryKeys.sessions, { sessions })
    }
    const resolvers: Array<(response: SessionResponse) => void> = []
    const getSession = vi.fn(() => new Promise<SessionResponse>(done => { resolvers.push(done) }))
    const api = { getSession } as unknown as ApiClient
    const wrapper = ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client }, children)
    const resolve = (response: SessionResponse) => {
        for (const resolveOne of resolvers.splice(0)) resolveOne(response)
    }
    return { client, api, wrapper, getSession, resolve }
}

describe('useSession slim-row seeding', () => {
    it('renders immediately from the list row without waiting for the detail GET', () => {
        const { api, wrapper, getSession } = setup([slimRow])
        const { result } = renderHook(() => useSession(api, 's1'), { wrapper })

        // No awaits: the seed must be present on the very first render —
        // the 0-RTT contract (before: first paint gated on the detail GET
        // round trip).
        expect(result.current.session?.id).toBe('s1')
        expect(result.current.session?.metadata?.name).toBe('Seeded title')
        expect(result.current.session?.model).toBeNull()
        expect(result.current.isLoading).toBe(false)
        expect(result.current.error).toBeNull()
        // Seeding is render-only: the authoritative detail GET still fires.
        expect(getSession).toHaveBeenCalledWith('s1')
    })

    it('overwrites the seed when the detail GET lands, keeping the seed watermark', async () => {
        const { api, wrapper, resolve } = setup([slimRow])
        const { result } = renderHook(() => useSession(api, 's1'), { wrapper })
        expect(result.current.session?.metadata?.name).toBe('Seeded title')

        // waitFor (not bare act): react-query notifies observers on a
        // setTimeout(0) batch, so the swap lands a macrotask after resolve.
        await act(async () => {
            resolve(detailResponse({ model: 'gpt-5', modelReasoningEffort: 'high' }))
        })
        await waitFor(() => {
            expect(result.current.session?.model).toBe('gpt-5')
        })
        expect(result.current.session?.modelReasoningEffort).toBe('high')
        expect(result.current.session?.metadata?.name).toBe('Real title')
        expect((result.current.session?.metadata as unknown as { host?: string }).host).toBe('macbook')
        expect(result.current.session?.agentState).toEqual({ requests: {} })
        // The existing queryFn merge must keep the (newer) seed watermark
        // over the older REST snapshot.
        expect(result.current.session?.contentRevision).toBe(9)
    })

    it('deep links to ids absent from the list keep the loading gate', () => {
        const { api, wrapper, getSession } = setup([slimRow])
        const { result } = renderHook(() => useSession(api, 's-other'), { wrapper })
        expect(result.current.session).toBeNull()
        expect(getSession).toHaveBeenCalledWith('s-other')
    })
})
