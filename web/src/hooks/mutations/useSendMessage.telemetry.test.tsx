import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { TELEMETRY_KINDS } from '@hapi/protocol/telemetry'
import { useSendMessage } from './useSendMessage'
import type { ApiClient } from '@/api/client'
import { resetTurnLatencyForTests } from '@/chat/turnLatency'

vi.mock('@/lib/message-window-store', () => ({
    appendOptimisticMessage: vi.fn(),
    getMessageWindowState: vi.fn(() => ({ messages: [] })),
    updateMessageStatus: vi.fn(),
    removeOptimisticMessage: vi.fn(),
}))

vi.mock('@/hooks/usePlatform', () => ({
    usePlatform: () => ({
        haptic: { notification: vi.fn() },
    }),
}))

vi.mock('@/lib/messages', () => ({
    makeClientSideId: vi.fn(() => 'local-id-1'),
}))

vi.mock('@/lib/telemetryClient', () => ({
    telemetryClient: { capture: vi.fn(), setTrigger: vi.fn() },
    bindTelemetryClient: vi.fn(),
}))

import { telemetryClient } from '@/lib/telemetryClient'

const captureMock = vi.mocked(telemetryClient.capture)
const setTriggerMock = vi.mocked(telemetryClient.setTrigger)

function createWrapper() {
    const queryClient = new QueryClient({
        defaultOptions: { mutations: { retry: false } },
    })
    return function Wrapper({ children }: { children: ReactNode }) {
        return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    }
}

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((res, rej) => {
        resolve = res
        reject = rej
    })
    return { promise, resolve, reject }
}

function stallEvents(): Array<Record<string, unknown>> {
    return captureMock.mock.calls.filter((call) => call[1] === 'send_stall').map((call) => call[2])
}

function expectSchemaValid(data: unknown): void {
    const parsed = TELEMETRY_KINDS.send_stall!.data.safeParse(data)
    if (!parsed.success) {
        throw new Error(`schema violation: ${JSON.stringify(parsed.error.issues)}`)
    }
}

beforeEach(() => {
    resetTurnLatencyForTests()
    captureMock.mockClear()
    setTriggerMock.mockClear()
})

afterEach(() => {
    vi.useRealTimers()
})

describe('useSendMessage send_stall telemetry', () => {
    it('marks the watchdog timeout at 10s pendingMs', async () => {
        vi.useFakeTimers()
        const request = deferred<void>()
        const api = { sendMessage: () => request.promise } as unknown as ApiClient
        const { result } = renderHook(() => useSendMessage(api, 'session-A'), { wrapper: createWrapper() })

        await act(async () => {
            void result.current.sendMessage('hello')
        })
        await act(async () => { await vi.advanceTimersByTimeAsync(9_900) })
        expect(stallEvents()).toHaveLength(0)
        await act(async () => { await vi.advanceTimersByTimeAsync(200) })

        const events = stallEvents()
        expect(events).toHaveLength(1)
        expect(events[0]).toEqual({ pendingMs: 10_000, outcome: 'timeout-marked' })
        expectSchemaValid(events[0])
    })

    it('reports late-success when the POST settles after the watchdog', async () => {
        vi.useFakeTimers()
        const request = deferred<void>()
        const api = { sendMessage: () => request.promise } as unknown as ApiClient
        const onSuccess = vi.fn()
        const { result } = renderHook(() => useSendMessage(api, 'session-A', { onSuccess }), { wrapper: createWrapper() })

        await act(async () => {
            void result.current.sendMessage('hello')
        })
        await act(async () => { await vi.advanceTimersByTimeAsync(10_100) })
        await act(async () => {
            await request.resolve(undefined)
        })

        expect(onSuccess).toHaveBeenCalledWith('session-A')
        const outcomes = stallEvents().map((event) => event.outcome)
        expect(outcomes).toEqual(['timeout-marked', 'late-success'])
        expectSchemaValid(stallEvents()[1])
        // a settled send arms the turn-latency clock (fetch attribution)
        expect(setTriggerMock).toHaveBeenCalledWith('send')
    })

    it('reports late-error when the POST fails after the watchdog', async () => {
        vi.useFakeTimers()
        const request = deferred<void>()
        const api = { sendMessage: () => request.promise } as unknown as ApiClient
        const { result } = renderHook(() => useSendMessage(api, 'session-A'), { wrapper: createWrapper() })

        await act(async () => {
            void result.current.sendMessage('hello')
        })
        await act(async () => { await vi.advanceTimersByTimeAsync(10_100) })
        await act(async () => {
            await request.reject(new Error('gateway died'))
        })
        await act(async () => { await vi.advanceTimersByTimeAsync(0) })

        const outcomes = stallEvents().map((event) => event.outcome)
        expect(outcomes).toEqual(['timeout-marked', 'late-error'])
        expectSchemaValid(stallEvents()[1])
    })

    it('a fast send emits no send_stall and still arms the turn clock', async () => {
        vi.useFakeTimers()
        const api = { sendMessage: async () => undefined } as unknown as ApiClient
        const onSuccess = vi.fn()
        const { result } = renderHook(() => useSendMessage(api, 'session-A', { onSuccess }), { wrapper: createWrapper() })

        await act(async () => {
            void result.current.sendMessage('hello')
        })
        await act(async () => { await Promise.resolve() })
        expect(onSuccess).toHaveBeenCalledWith('session-A')
        await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })

        expect(stallEvents()).toHaveLength(0)
        expect(setTriggerMock).toHaveBeenCalledWith('send')
    })
})
