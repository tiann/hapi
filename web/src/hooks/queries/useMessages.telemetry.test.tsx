import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { TELEMETRY_KINDS } from '@hapi/protocol/telemetry'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage, MessagesResponse } from '@/types/api'
import { clearMessageWindow } from '@/lib/message-window-store'
import { useMessages } from './useMessages'

vi.mock('@/lib/telemetryClient', () => ({
    telemetryClient: { capture: vi.fn(), setTrigger: vi.fn(), getLevel: vi.fn(() => 1) },
    bindTelemetryClient: vi.fn(),
}))

import { telemetryClient } from '@/lib/telemetryClient'

const captureMock = vi.mocked(telemetryClient.capture)
const getLevelMock = vi.mocked(telemetryClient.getLevel)

function agentMessage(id: string, seq: number, at: number): DecryptedMessage {
    return {
        id,
        seq,
        localId: null,
        content: {
            role: 'agent',
            content: { type: 'codex', data: { type: 'reasoning', message: id, id: `stream-${id}` } }
        },
        createdAt: at,
        invokedAt: at
    } as DecryptedMessage
}

function latestResponse(messages: DecryptedMessage[], epoch = 1): MessagesResponse {
    return {
        messages,
        page: {
            direction: 'latest',
            limit: 200,
            epoch,
            reset: false,
            nextBeforeAt: null,
            nextBeforeSeq: null,
            nextAfterAt: null,
            nextAfterSeq: null,
            snapshotHeadAt: null,
            snapshotHeadSeq: null,
            hasMore: false
        }
    }
}

function makeApi(handler: ApiClient['getMessages']): ApiClient {
    return { getMessages: handler, getMessageContext: async () => null } as unknown as ApiClient
}

function eventsOf(kind: string): Array<Record<string, unknown>> {
    return captureMock.mock.calls.filter((call) => call[1] === kind).map((call) => call[2])
}

function expectSchemaValid(kind: string, data: unknown): void {
    const spec = TELEMETRY_KINDS[kind]
    expect(spec, `kind ${kind} must be registered`).toBeDefined()
    const parsed = spec!.data.safeParse(data)
    if (!parsed.success) {
        throw new Error(`schema violation for ${kind}: ${JSON.stringify(parsed.error.issues)}`)
    }
}

let sessionIdCounter = 0
let sessionId: string

beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-20T10:00:00Z'))
    captureMock.mockClear()
    getLevelMock.mockReturnValue(1)
    localStorage.clear()
    sessionIdCounter += 1
    sessionId = `telemetry-use-messages-${sessionIdCounter}`
})

afterEach(() => {
    clearMessageWindow(sessionId)
    localStorage.clear()
    sessionStorage.clear()
    vi.useRealTimers()
})

describe('useMessages telemetry', () => {
    it('data_loaded on cold open: cacheHitOnActivate=false + messageCountAfterSync', async () => {
        const api = makeApi(async () => latestResponse([agentMessage('m1', 1, 1_000)]))
        const { result } = renderHook(() => useMessages(api, sessionId))

        await act(async () => {
            await vi.advanceTimersByTimeAsync(400)
        })

        expect(result.current.messages).toHaveLength(1)
        const loaded = eventsOf('data_loaded')
        expect(loaded).toHaveLength(1)
        expect(loaded[0]).toMatchObject({ cacheHitOnActivate: false, messageCountAfterSync: 1 })
        expect(typeof loaded[0]!.settledAt).toBe('number')
        expectSchemaValid('data_loaded', loaded[0])
    })

    it('data_loaded on cached re-entry: cacheHitOnActivate=true (persisted window rehydrate)', async () => {
        sessionStorage.setItem(`hapi:message-window:v2:${sessionId}`, JSON.stringify({
            messages: [agentMessage('cached', 1, 1_000)],
            hasMore: true,
            oldestPositionAt: 900,
            oldestPositionSeq: 0,
            newestPositionAt: 1_000,
            newestPositionSeq: 1,
            contextNewestAt: null,
            contextNewestSeq: null,
            epoch: 1,
            requiresLatestReset: false,
        }))
        const api = makeApi(async () => latestResponse([agentMessage('fresh', 2, 2_000)]))

        const { result } = renderHook(() => useMessages(api, sessionId))
        await act(async () => {
            await vi.advanceTimersByTimeAsync(400)
        })

        const loaded = eventsOf('data_loaded')
        expect(loaded).toHaveLength(1)
        expect(loaded[0]).toMatchObject({ cacheHitOnActivate: true })
        expect(result.current.messages.length).toBeGreaterThan(0)
        expectSchemaValid('data_loaded', loaded[0])
    })

    it('load_slow fires for the tail-sync phase past 5s (session-detail also crossed)', async () => {
        const api = makeApi(() => new Promise((resolve) => {
            setTimeout(() => resolve(latestResponse([agentMessage('m1', 1, 1_000)])), 5_500)
        }))
        renderHook(() => useMessages(api, sessionId))

        await act(async () => {
            await vi.advanceTimersByTimeAsync(6_200)
        })

        const slow = eventsOf('load_slow')
        const tailSync = slow.filter((e) => e.phase === 'tail-sync')
        expect(tailSync).toHaveLength(1)
        expect(tailSync[0]).toMatchObject({ durationMs: 5_500, fromCache: false })
        expectSchemaValid('load_slow', tailSync[0])
        // a 5.5s cold open also crosses the 3s session-detail budget — both
        // phases legitimately report
        const sessionDetail = slow.filter((e) => e.phase === 'session-detail')
        expect(sessionDetail).toHaveLength(1)
        expectSchemaValid('load_slow', sessionDetail[0])
        // data_loaded still settles
        expect(eventsOf('data_loaded')).toHaveLength(1)
    })

    it('load_slow fires for the session-detail phase between 3s and 5s', async () => {
        const api = makeApi(() => new Promise((resolve) => {
            setTimeout(() => resolve(latestResponse([agentMessage('m1', 1, 1_000)])), 3_500)
        }))
        renderHook(() => useMessages(api, sessionId))

        await act(async () => {
            await vi.advanceTimersByTimeAsync(4_200)
        })

        const slow = eventsOf('load_slow')
        expect(slow).toHaveLength(1)
        expect(slow[0]).toMatchObject({ phase: 'session-detail', durationMs: 3_500, fromCache: false })
        expectSchemaValid('load_slow', slow[0])
    })

    it('level 0 (telemetry off): the session-detail observation never starts a poll interval', async () => {
        getLevelMock.mockReturnValue(0)
        const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
        const api = makeApi(async () => latestResponse([agentMessage('m1', 1, 1_000)]))
        renderHook(() => useMessages(api, sessionId))
        await act(async () => {
            await vi.advanceTimersByTimeAsync(1_000)
        })
        expect(setIntervalSpy).not.toHaveBeenCalled()
        setIntervalSpy.mockRestore()
    })

    it('confirmed-empty session: the poll stops after the sync settles with zero messages', async () => {
        const api = makeApi(async () => latestResponse([]))
        renderHook(() => useMessages(api, sessionId))
        await act(async () => {
            await vi.advanceTimersByTimeAsync(1_600)
        })
        // no session-detail metric fires for an empty window, and the poll
        // has torn itself down (no pending timers left behind)
        expect(eventsOf('load_slow')).toHaveLength(0)
        expect(vi.getTimerCount()).toBe(0)
    })
})
