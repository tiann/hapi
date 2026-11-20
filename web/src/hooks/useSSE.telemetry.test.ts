import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TELEMETRY_KINDS } from '@hapi/protocol/telemetry'
import { resetSseTelemetryForTests } from '@/lib/sseTelemetryObserver'
import { resetTurnLatencyForTests, noteSendSettled } from '@/chat/turnLatency'
import { useSSE } from './useSSE'

vi.mock('@/lib/telemetryClient', () => ({
    telemetryClient: { capture: vi.fn(), setTrigger: vi.fn() },
    bindTelemetryClient: vi.fn(),
}))

import { telemetryClient } from '@/lib/telemetryClient'

const captureMock = vi.mocked(telemetryClient.capture)

class FakeEventSource {
    static instances: FakeEventSource[] = []
    static readonly CONNECTING = 0
    static readonly OPEN = 1
    static readonly CLOSED = 2
    readonly url: string
    readyState = FakeEventSource.CONNECTING
    onopen: (() => void) | null = null
    onmessage: ((event: MessageEvent<string>) => void) | null = null
    onerror: ((error: unknown) => void) | null = null

    constructor(url: string) {
        this.url = url
        FakeEventSource.instances.push(this)
    }

    close(): void {
        this.readyState = FakeEventSource.CLOSED
    }

    simulateOpen(): void {
        this.readyState = FakeEventSource.OPEN
        this.onopen?.()
    }

    simulateMessage(data: unknown): void {
        this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent<string>)
    }
}

function eventsOf(kind: string): Array<Record<string, unknown>> {
    return captureMock.mock.calls.filter((call) => call[1] === kind).map((call) => call[2])
}

function anomalies(anomaly: string): Array<Record<string, unknown>> {
    return eventsOf('sse_anomaly').filter((data) => data.anomaly === anomaly)
}

function expectSchemaValid(kind: string, data: unknown): void {
    const spec = TELEMETRY_KINDS[kind]
    expect(spec, `kind ${kind} must be registered`).toBeDefined()
    const parsed = spec!.data.safeParse(data)
    if (!parsed.success) {
        throw new Error(`schema violation for ${kind}: ${JSON.stringify(parsed.error.issues)}`)
    }
}

function wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: new QueryClient() }, children)
}

beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-20T10:00:00Z'))
    FakeEventSource.instances = []
    vi.stubGlobal('EventSource', FakeEventSource)
    resetSseTelemetryForTests()
    resetTurnLatencyForTests()
    captureMock.mockClear()
})

afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
})

describe('useSSE telemetry wiring', () => {
    it('terminates an episode with counted events, wire bytes and the handshake verdict', () => {
        const { unmount } = renderHook(() => useSSE({
            enabled: true,
            token: 't',
            baseUrl: 'http://hub.test',
            subscription: { all: true },
            scope: 'global',
            onEvent: () => {},
        }), { wrapper })

        const source = FakeEventSource.instances[0]!
        act(() => { source.simulateOpen() })
        act(() => {
            source.simulateMessage({ type: 'connection-changed', data: { subscriptionId: 'sub-77', resume: 'ok' } })
            source.simulateMessage({ type: 'heartbeat' })
        })
        act(() => { vi.advanceTimersByTime(2_000) })
        act(() => { source.onerror?.({}) })

        const episodes = eventsOf('sse_episode')
        expect(episodes).toHaveLength(1)
        expect(episodes[0]).toMatchObject({
            scope: 'global',
            subscriptionId: 'sub-77',
            resume: 'ok',
            eventsCount: 2,
            disconnectReason: 'transport-error',
        })
        // wire bytes = serialized.length * 2 across both parsed events
        expect(episodes[0]!.bytesSent).toBe(
            JSON.stringify({ type: 'connection-changed', data: { subscriptionId: 'sub-77', resume: 'ok' } }).length * 2
            + JSON.stringify({ type: 'heartbeat' }).length * 2
        )
        expectSchemaValid('sse_episode', episodes[0])

        act(() => { vi.advanceTimersByTime(600) }) // reconnect scheduled
        unmount()
        // the reconnect episode also ends (unsubscribe); the first one is not
        // double-counted
        expect(eventsOf('sse_episode').filter((e) => e.disconnectReason === 'transport-error')).toHaveLength(1)
    })

    it('same-subscription reconnect without resume emits the gap anomaly', () => {
        const { unmount } = renderHook(() => useSSE({
            enabled: true,
            token: 't',
            baseUrl: 'http://hub.test',
            subscription: { all: true },
            scope: 'global',
            onEvent: () => {},
        }), { wrapper })

        const first = FakeEventSource.instances[0]!
        act(() => { first.simulateOpen() })
        act(() => { first.onerror?.({}) })
        act(() => { vi.advanceTimersByTime(600) }) // reconnect attempt
        const second = FakeEventSource.instances[1]!
        expect(second).toBeDefined()
        act(() => { vi.advanceTimersByTime(3_500) })
        act(() => { second.simulateOpen() })
        act(() => {
            // older hub: resume field absent -> full resync, and a prior
            // episode of the same subscription ended -> gap
            second.simulateMessage({ type: 'connection-changed', data: { subscriptionId: 'sub-2' } })
        })

        const gaps = anomalies('gap')
        expect(gaps).toHaveLength(1)
        expect(gaps[0]).toMatchObject({ resumedAfterGap: true })
        expect(typeof gaps[0]!.outageMs).toBe('number')
        expectSchemaValid('sse_anomaly', gaps[0])

        unmount()
    })

    it('message-received feeds the turn-latency first-agent clock and thinking completes the turn', () => {
        const { unmount } = renderHook(() => useSSE({
            enabled: true,
            token: 't',
            baseUrl: 'http://hub.test',
            subscription: { sessionId: 's-turn' },
            scope: 'full',
            onEvent: () => {},
        }), { wrapper })

        const source = FakeEventSource.instances[0]!
        act(() => { source.simulateOpen() })

        act(() => { noteSendSettled('s-turn') })
        act(() => { vi.advanceTimersByTime(1_800) })
        act(() => {
            source.simulateMessage({
                type: 'message-received',
                sessionId: 's-turn',
                message: {
                    id: 'agent-1',
                    seq: 5,
                    localId: null,
                    content: { role: 'agent', content: { type: 'codex', data: { type: 'reasoning', message: 'hi', id: 'stream-1' } } },
                    createdAt: Date.now(),
                    invokedAt: Date.now(),
                },
            })
        })
        // user-role rows do not break the silence
        act(() => {
            source.simulateMessage({
                type: 'message-received',
                sessionId: 's-turn',
                message: {
                    id: 'user-1',
                    seq: 6,
                    localId: null,
                    content: { role: 'user', content: { type: 'text', text: 'x' } },
                    createdAt: Date.now(),
                    invokedAt: Date.now(),
                },
            })
        })
        act(() => { vi.advanceTimersByTime(2_200) })
        act(() => {
            source.simulateMessage({ type: 'session-updated', sessionId: 's-turn', data: { thinking: false } })
        })

        const turns = eventsOf('turn_latency')
        expect(turns).toHaveLength(1)
        expect(turns[0]).toMatchObject({
            outcome: 'completed',
            firstAgentMs: 1_800,
            firstEventKind: 'reasoning',
            turnTotalMs: 4_000,
        })
        expectSchemaValid('turn_latency', turns[0])

        unmount()
    })

    it('stall predicate: in-turn silence of 30s fires once, turn end disarms', () => {
        const { unmount } = renderHook(() => useSSE({
            enabled: true,
            token: 't',
            baseUrl: 'http://hub.test',
            subscription: { sessionId: 's-stall' },
            scope: 'full',
            onEvent: () => {},
        }), { wrapper })

        const source = FakeEventSource.instances[0]!
        act(() => { source.simulateOpen() })

        // turn starts (thinking=true): silence clock armed
        act(() => {
            source.simulateMessage({ type: 'session-updated', sessionId: 's-stall', data: { thinking: true } })
        })
        act(() => { vi.advanceTimersByTime(29_000) })
        expect(anomalies('stall')).toHaveLength(0)

        act(() => { vi.advanceTimersByTime(1_100) })
        expect(anomalies('stall')).toHaveLength(1)
        expectSchemaValid('sse_anomaly', anomalies('stall')[0])

        // turn ends: no further stalls even after long silence
        act(() => {
            source.simulateMessage({ type: 'session-updated', sessionId: 's-stall', data: { thinking: false } })
        })
        act(() => { vi.advanceTimersByTime(120_000) })
        expect(anomalies('stall')).toHaveLength(1)

        unmount()
    })

    it('stall does not fire for sessions without a session-scoped subscription', () => {
        const { unmount } = renderHook(() => useSSE({
            enabled: true,
            token: 't',
            baseUrl: 'http://hub.test',
            subscription: { all: true },
            scope: 'global',
            onEvent: () => {},
        }), { wrapper })

        const source = FakeEventSource.instances[0]!
        act(() => { source.simulateOpen() })
        act(() => {
            source.simulateMessage({ type: 'session-updated', sessionId: 's-any', data: { thinking: true } })
        })
        act(() => { vi.advanceTimersByTime(120_000) })
        expect(anomalies('stall')).toHaveLength(0)

        unmount()
    })
})
