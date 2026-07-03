import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isGlobalScopedMessageStreamEvent, useSSE } from './useSSE'

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

function renderUseSSE(options?: { onDisconnect?: (reason: string) => void }) {
    const queryClient = new QueryClient()
    const wrapper = ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client: queryClient }, children)
    return renderHook(() => useSSE({
        enabled: true,
        token: 'test-token',
        baseUrl: 'http://hub.test',
        subscription: { all: true },
        onEvent: () => {},
        onDisconnect: options?.onDisconnect
    }), { wrapper })
}

describe('useSSE connection liveness', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        FakeEventSource.instances = []
        vi.stubGlobal('EventSource', FakeEventSource)
    })

    afterEach(() => {
        vi.unstubAllGlobals()
        vi.useRealTimers()
    })

    it('reconnects on visibility resume when a heartbeat interval was missed', () => {
        const onDisconnect = vi.fn()
        const { unmount } = renderUseSSE({ onDisconnect })

        expect(FakeEventSource.instances).toHaveLength(1)
        act(() => { FakeEventSource.instances[0]?.simulateOpen() })

        // Silence for 70s: more than one 30s heartbeat missed, but below the
        // 90s watchdog threshold. A resume from background must not trust
        // this connection.
        act(() => { vi.advanceTimersByTime(70_000) })
        act(() => { document.dispatchEvent(new Event('visibilitychange')) })

        expect(onDisconnect).toHaveBeenCalledWith('visibility-recovery')
        expect(FakeEventSource.instances[0]?.readyState).toBe(FakeEventSource.CLOSED)

        // First reconnect attempt is immediate (jitter only)
        act(() => { vi.advanceTimersByTime(600) })
        expect(FakeEventSource.instances).toHaveLength(2)

        unmount()
    })

    it('keeps a fresh connection on visibility resume', () => {
        const onDisconnect = vi.fn()
        const { unmount } = renderUseSSE({ onDisconnect })

        act(() => { FakeEventSource.instances[0]?.simulateOpen() })
        act(() => { vi.advanceTimersByTime(20_000) })
        act(() => { document.dispatchEvent(new Event('visibilitychange')) })

        expect(onDisconnect).not.toHaveBeenCalled()
        expect(FakeEventSource.instances).toHaveLength(1)

        unmount()
    })

    it('abandons a connection attempt that does not open in time', () => {
        const onDisconnect = vi.fn()
        const { unmount } = renderUseSSE({ onDisconnect })

        expect(FakeEventSource.instances).toHaveLength(1)
        // never opens (e.g. request hung on a dead pooled socket)
        act(() => { vi.advanceTimersByTime(10_100) })

        expect(onDisconnect).toHaveBeenCalledWith('connect-timeout')
        expect(FakeEventSource.instances[0]?.readyState).toBe(FakeEventSource.CLOSED)

        act(() => { vi.advanceTimersByTime(600) })
        expect(FakeEventSource.instances).toHaveLength(2)

        unmount()
    })

    it('does not time out a connection that opens promptly', () => {
        const onDisconnect = vi.fn()
        const { unmount } = renderUseSSE({ onDisconnect })

        act(() => { FakeEventSource.instances[0]?.simulateOpen() })
        act(() => {
            FakeEventSource.instances[0]?.simulateMessage({ type: 'heartbeat', namespace: 'default', data: {} })
        })
        act(() => { vi.advanceTimersByTime(30_000) })

        expect(onDisconnect).not.toHaveBeenCalled()
        expect(FakeEventSource.instances).toHaveLength(1)

        unmount()
    })
})

describe('useSSE scope handling', () => {
    it('treats message stream events as global-scoped skips', () => {
        expect(isGlobalScopedMessageStreamEvent('global', 'message-received')).toBe(true)
        expect(isGlobalScopedMessageStreamEvent('global', 'messages-consumed')).toBe(true)
        expect(isGlobalScopedMessageStreamEvent('global', 'message-cancelled')).toBe(true)
        expect(isGlobalScopedMessageStreamEvent('global', 'scheduled-matured')).toBe(true)
    })

    it('does not skip session lifecycle events on the global connection', () => {
        expect(isGlobalScopedMessageStreamEvent('global', 'session-updated')).toBe(false)
        expect(isGlobalScopedMessageStreamEvent('global', 'session-added')).toBe(false)
        expect(isGlobalScopedMessageStreamEvent('global', 'session-removed')).toBe(false)
    })

    it('processes message stream events on full-scoped connections', () => {
        expect(isGlobalScopedMessageStreamEvent('full', 'message-received')).toBe(false)
    })
})
