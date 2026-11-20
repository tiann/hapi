import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { TELEMETRY_KINDS } from '@hapi/protocol/telemetry'
import { recordSessionEntry, resetSessionVisitTelemetryForTests } from '@/chat/sessionVisitTelemetry'
import { useSessionVisitTelemetry } from './useSessionVisitTelemetry'

vi.mock('@/lib/telemetryClient', () => ({
    telemetryClient: { capture: vi.fn(), setTrigger: vi.fn() },
    bindTelemetryClient: vi.fn(),
}))

import { telemetryClient } from '@/lib/telemetryClient'

const captureMock = vi.mocked(telemetryClient.capture)

function setVisibility(state: 'visible' | 'hidden'): void {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: state })
}

function openEvents(): Array<Record<string, unknown>> {
    return captureMock.mock.calls.filter((call) => call[1] === 'session_open').map((call) => call[2])
}

function closeEvents(): Array<Record<string, unknown>> {
    return captureMock.mock.calls.filter((call) => call[1] === 'session_close').map((call) => call[2])
}

function expectSchemaValid(kind: string, data: unknown): void {
    const spec = TELEMETRY_KINDS[kind]
    expect(spec, `kind ${kind} must be registered`).toBeDefined()
    const parsed = spec!.data.safeParse(data)
    if (!parsed.success) {
        throw new Error(`schema violation for ${kind}: ${JSON.stringify(parsed.error.issues)}`)
    }
}

beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-20T10:00:00Z'))
    resetSessionVisitTelemetryForTests()
    captureMock.mockClear()
    vi.mocked(telemetryClient.setTrigger).mockClear()
    setVisibility('visible')
})

afterEach(() => {
    vi.useRealTimers()
})

describe('useSessionVisitTelemetry', () => {
    it('consumes a recorded list-click entry and reports fromSessionId on switch', () => {
        recordSessionEntry('s2', 'list-click')
        const { rerender } = renderHook(
            ({ id }) => useSessionVisitTelemetry(id),
            { initialProps: { id: 's1' } },
        )

        expect(openEvents()).toHaveLength(1)
        expect(openEvents()[0]).toMatchObject({ entry: 'url-direct' })

        act(() => {
            rerender({ id: 's2' })
        })

        // s1 left because of a session SWITCH; s2 opened with the recorded
        // entry and fromSessionId pointing at s1.
        expect(closeEvents()).toHaveLength(1)
        expect(closeEvents()[0]).toMatchObject({ exit: 'switch' })
        expect(openEvents()).toHaveLength(2)
        expect(openEvents()[1]).toMatchObject({ entry: 'list-click', fromSessionId: 's1' })
        expectSchemaValid('session_open', openEvents()[1])
        expectSchemaValid('session_close', closeEvents()[0])
    })

    it('classifies unmount as navigate-away', () => {
        const { unmount } = renderHook(() => useSessionVisitTelemetry('s1'))
        act(() => {
            unmount()
        })
        expect(closeEvents()).toHaveLength(1)
        expect(closeEvents()[0]).toMatchObject({ exit: 'navigate-away' })
    })

    it('derives permission-jump and search-hit from open-time URL params', () => {
        type Hint = { messageId?: string | null; pendingRequestId?: string | null }
        const { rerender } = renderHook(
            ({ id, hint }: { id: string; hint: Hint }) => useSessionVisitTelemetry(id, { searchHint: hint }),
            { initialProps: { id: 's1', hint: { pendingRequestId: 'pr-7' } as Hint } },
        )
        expect(openEvents()[0]).toMatchObject({ entry: 'permission-jump' })

        rerender({ id: 's2', hint: { messageId: 'msg-3' } })
        expect(openEvents()[1]).toMatchObject({ entry: 'search-hit', navTargetMessageId: 'msg-3' })
        expectSchemaValid('session_open', openEvents()[1])
    })

    it('16-minute background through the hook: one close + one resume open', () => {
        const { rerender } = renderHook(({ id }) => useSessionVisitTelemetry(id), { initialProps: { id: 's1' } })

        act(() => {
            setVisibility('hidden')
            document.dispatchEvent(new Event('visibilitychange'))
        })
        act(() => {
            vi.advanceTimersByTime(16 * 60 * 1000)
        })
        act(() => {
            setVisibility('visible')
            document.dispatchEvent(new Event('visibilitychange'))
        })

        const closes = closeEvents()
        const opens = openEvents()
        expect(closes).toHaveLength(1)
        expect(closes[0]).toMatchObject({ exit: 'hidden-timeout' })
        expect(opens).toHaveLength(2)
        expect(opens[1]).toMatchObject({ entry: 'resume-after-timeout' })

        rerender({ id: 's1' }) // same session: no spurious close/open
        expect(closeEvents()).toHaveLength(1)
        expect(openEvents()).toHaveLength(2)
    })

    it('reports seenTail from the close-time callback', () => {
        const { rerender } = renderHook(
            ({ id }) => useSessionVisitTelemetry(id, { getSeenTail: () => false }),
            { initialProps: { id: 's1' } },
        )
        act(() => {
            rerender({ id: 's2' })
        })
        const closes = closeEvents()
        expect(closes[0]).toMatchObject({ seenTail: false })
        expectSchemaValid('session_close', closes[0])
    })
})
