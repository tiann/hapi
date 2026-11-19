import { createElement, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { SessionsResponse, SessionSummary } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import { useSSE } from '../useSSE'
import { useSessions } from './useSessions'

afterEach(cleanup)

function row(id: string, at: number): SessionSummary {
    return {
        id, createdAt: 1, lastUserMessageAt: at, updatedAt: at,
        active: false, thinking: false, activeAt: 0, metadata: null,
        metadataVersion: 0, agentStateVersion: 0, todosUpdatedAt: 0,
        todoProgress: null, pendingRequestsCount: 0, pendingRequestKinds: [], pendingRequests: [],
        backgroundTaskCount: 0, futureScheduledMessageCount: 0, nextScheduledAt: null,
        attachedJob: null, attachedJobUpdatedAt: 0,
        model: null, effort: null
    }
}

it('does not let a delayed REST snapshot undo newer user input from SSE', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const initial = { sessions: [row('b', 200), row('a', 100), row('removed', 50)] }
    client.setQueryData(queryKeys.sessions, initial)
    let resolve!: (response: SessionsResponse) => void
    const getSessions = vi.fn(() => new Promise<SessionsResponse>(done => { resolve = done }))
    const api = { getSessions } as unknown as ApiClient
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)
    const { result } = renderHook(() => useSessions(api, { enabled: false }), { wrapper })
    await act(async () => {
        const pending = result.current.refetch()
        client.setQueryData(queryKeys.sessions, { sessions: [row('a', 300), row('b', 200), row('removed', 50)] })
        resolve({ sessions: [row('b', 200), row('a', 100)] })
        await pending
    })
    const data = client.getQueryData<SessionsResponse>(queryKeys.sessions)!
    expect(data.sessions.map(s => s.id)).toEqual(['a', 'b'])
    expect(data.sessions[0]!.lastUserMessageAt).toBe(300)
})

it.each([
    ['matching scope', 'epoch:2:ns', 'epoch:3:ns', 0],
    ['different epoch', 'epoch:2:ns', 'older-epoch:3:ns', 1],
    ['different namespace', 'epoch:2:ns', 'epoch:3:other-ns', 1]
])('reconciles a delayed scheduled-message snapshot with %s', async (_case, snapshotCursor, eventId, expectedCount) => {
    const client = new QueryClient()
    const session = row('scheduled', 100)
    client.setQueryData(queryKeys.sessions, { sessions: [session], sessionScheduleCursor: snapshotCursor })
    let resolve!: (response: SessionsResponse) => void
    const api = { getSessions: () => new Promise<SessionsResponse>(done => { resolve = done }) } as unknown as ApiClient
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)
    const { result } = renderHook(() => useSessions(api, { enabled: false }), { wrapper })
    await act(async () => {
        const pending = result.current.refetch()
        // A cancellation restored the prior visible values after the hub took this snapshot.
        client.setQueryData(queryKeys.sessions, {
            sessions: [{ ...session, sessionScheduleEventId: eventId }],
            sessionScheduleCursor: snapshotCursor
        })
        resolve({
            sessions: [{ ...session, futureScheduledMessageCount: 1, nextScheduledAt: 200 }],
            sessionScheduleCursor: snapshotCursor
        })
        await pending
    })
    expect(client.getQueryData<SessionsResponse>(queryKeys.sessions)?.sessions[0]).toMatchObject({
        futureScheduledMessageCount: expectedCount,
        nextScheduledAt: expectedCount ? 200 : null
    })
})

it.each([false, true])('retains an SSE-inserted row across an older list snapshot (scheduled: %s)', async (scheduled) => {
    let receive: (event: object, eventId: string) => void = () => { throw new Error('No event stream') }
    vi.stubGlobal('EventSource', class {
        onmessage: ((event: MessageEvent<string>) => void) | null = null
        constructor() {
            receive = (event, eventId) => this.onmessage?.(new MessageEvent('message', {
                data: JSON.stringify(event), lastEventId: eventId
            }))
        }
        close() {}
    })
    const client = new QueryClient()
    const initial = row('existing', 100)
    client.setQueryData(queryKeys.sessions, {
        sessions: [initial, row('removed', 50)],
        sessionScheduleCursor: 'epoch:1:ns'
    })
    let resolve!: (response: SessionsResponse) => void
    const api = { getSessions: () => new Promise<SessionsResponse>(done => { resolve = done }) } as unknown as ApiClient
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)
    const { result, unmount } = renderHook(() => {
        useSSE({ enabled: true, token: 'test', baseUrl: 'http://hub.test', scope: 'global', subscription: { all: true }, onEvent: () => {} })
        return useSessions(api, { enabled: false })
    }, { wrapper })
    const read = () => client.getQueryData<SessionsResponse>(queryKeys.sessions)!.sessions
    const future = { futureScheduledMessageCount: 1, nextScheduledAt: 1_000 }
    const added = {
        ...row('new', 200), namespace: 'default', seq: 0, thinkingAt: 0, agentState: null
    }
    try {
        await act(async () => {
            const pending = result.current.refetch()
            receive({ type: 'session-added', sessionId: added.id, data: added }, 'epoch:3:ns')
            if (scheduled) {
                receive({
                    type: 'message-received', sessionId: added.id,
                    message: { id: 'prompt', seq: 1, localId: 'local-prompt', content: {}, createdAt: 200, invokedAt: null, scheduledAt: 1_000 },
                    sessionSchedule: future
                }, 'epoch:4:ns')
            }
            expect(read()[0]).toMatchObject({
                id: added.id, ...(scheduled ? future : { futureScheduledMessageCount: 0, nextScheduledAt: null })
            })
            resolve({ sessions: [initial], sessionScheduleCursor: 'epoch:2:ns' })
            await pending
        })
        expect(read().map(session => session.id)).toEqual([added.id, initial.id])
        expect(read()[0]).toMatchObject(scheduled ? future : { futureScheduledMessageCount: 0, nextScheduledAt: null })

        await act(async () => {
            const pending = result.current.refetch()
            resolve({ sessions: [initial], sessionScheduleCursor: 'epoch:5:ns' })
            await pending
        })
        expect(read().map(session => session.id)).toEqual([initial.id])
    } finally {
        unmount()
        vi.unstubAllGlobals()
    }
})
