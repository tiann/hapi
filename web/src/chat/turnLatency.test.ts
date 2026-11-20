import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TELEMETRY_KINDS } from '@hapi/protocol/telemetry'
import {
    TURN_LATENCY_KIND,
    noteAgentMessage,
    noteSendSettled,
    noteThinking,
    noteVisitClosed,
    resetTurnLatencyForTests,
} from './turnLatency'

vi.mock('@/lib/telemetryClient', () => ({
    telemetryClient: { capture: vi.fn(), setTrigger: vi.fn() },
    bindTelemetryClient: vi.fn(),
}))

import { telemetryClient } from '@/lib/telemetryClient'

const captureMock = vi.mocked(telemetryClient.capture)
const setTriggerMock = vi.mocked(telemetryClient.setTrigger)

function turnEvents(): Array<Record<string, unknown>> {
    return captureMock.mock.calls.filter((call) => call[1] === TURN_LATENCY_KIND).map((call) => call[2])
}

function expectSchemaValid(data: unknown): void {
    const spec = TELEMETRY_KINDS[TURN_LATENCY_KIND]
    const parsed = spec.data.safeParse(data)
    if (!parsed.success) {
        throw new Error(`schema violation: ${JSON.stringify(parsed.error.issues)}`)
    }
}

beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-20T10:00:00Z'))
    resetTurnLatencyForTests()
    captureMock.mockClear()
    setTriggerMock.mockClear()
})

afterEach(() => {
    vi.useRealTimers()
})

describe('turnLatency', () => {
    it('completed turn: firstAgentMs numeric + firstEventKind + turnTotalMs', () => {
        noteSendSettled('s1')
        expect(setTriggerMock).toHaveBeenCalledWith('send')

        vi.advanceTimersByTime(1_500) // first agent event breaks the silence
        noteAgentMessage('s1', 'reasoning')

        vi.advanceTimersByTime(2_500) // agent works, then the turn ends
        noteThinking('s1', false)

        const events = turnEvents()
        expect(events).toHaveLength(1)
        expect(events[0]).toEqual({
            firstAgentMs: 1_500,
            firstEventKind: 'reasoning',
            turnTotalMs: 4_000,
            outcome: 'completed',
        })
        expectSchemaValid(events[0])
        expect(setTriggerMock).toHaveBeenCalledWith(null)
    })

    it('ignores later agent messages for the same turn and other sessions', () => {
        noteSendSettled('s1')
        vi.advanceTimersByTime(1_000)
        noteAgentMessage('s1', 'tool-call')
        vi.advanceTimersByTime(500)
        noteAgentMessage('s1', 'text') // second event: ignored
        noteAgentMessage('other', 'text') // other session: no turn armed
        noteThinking('other', false) // no turn there either
        vi.advanceTimersByTime(2_000)
        noteThinking('s1', false)

        const events = turnEvents()
        expect(events).toHaveLength(1)
        expect(events[0]).toMatchObject({ firstAgentMs: 1_000, firstEventKind: 'tool-call', outcome: 'completed' })
    })

    it('a newer send aborts the pending turn keeping only recorded fields', () => {
        noteSendSettled('s1')
        vi.advanceTimersByTime(1_200)
        noteAgentMessage('s1', 'text')
        vi.advanceTimersByTime(800)
        noteSendSettled('s1') // second send preempts the first turn

        const aborted = turnEvents()[0]
        expect(aborted).toEqual({
            firstAgentMs: 1_200,
            firstEventKind: 'text',
            outcome: 'aborted',
        })
        expectSchemaValid(aborted)

        // The new turn completes normally afterwards.
        vi.advanceTimersByTime(3_000)
        noteAgentMessage('s1', 'reasoning')
        vi.advanceTimersByTime(1_000)
        noteThinking('s1', false)
        const completed = turnEvents()[1]
        expect(completed).toMatchObject({ outcome: 'completed', turnTotalMs: 4_000 })
    })

    it('visit close aborts the pending turn', () => {
        noteSendSettled('s1')
        vi.advanceTimersByTime(700)
        noteVisitClosed('s1')
        const events = turnEvents()
        expect(events).toHaveLength(1)
        expect(events[0]).toEqual({ outcome: 'aborted' })
        expectSchemaValid(events[0])
    })

    it('thinking=true alone starts nothing and completes nothing', () => {
        noteThinking('s1', true)
        vi.advanceTimersByTime(60_000)
        noteThinking('s1', false)
        expect(turnEvents()).toHaveLength(0)
    })
})
