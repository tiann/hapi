import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TELEMETRY_KINDS } from '@hapi/protocol/telemetry'
import {
    SSE_STALL_MS,
    SSE_STORM_THRESHOLD,
    armSessionStall,
    disarmSessionStall,
    noteSessionMessage,
    noteSessionThinking,
    noteSseDisconnected,
    resetSseTelemetryForTests,
    startSseEpisode,
} from './sseTelemetryObserver'

vi.mock('@/lib/telemetryClient', () => ({
    telemetryClient: { capture: vi.fn(), setTrigger: vi.fn() },
    bindTelemetryClient: vi.fn(),
}))

import { telemetryClient } from '@/lib/telemetryClient'

const captureMock = vi.mocked(telemetryClient.capture)

function anomalyEvents(anomaly: string): Array<Record<string, unknown>> {
    return captureMock.mock.calls
        .filter((call) => call[1] === 'sse_anomaly' && (call[2] as { anomaly?: string }).anomaly === anomaly)
        .map((call) => call[2])
}

function episodeEvents(): Array<Record<string, unknown>> {
    return captureMock.mock.calls.filter((call) => call[1] === 'sse_episode').map((call) => call[2])
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
    resetSseTelemetryForTests()
    captureMock.mockClear()
})

afterEach(() => {
    vi.useRealTimers()
})

describe('sse episode lifecycle', () => {
    it('counts events and wire bytes and terminates with the reconnect reason', () => {
        const episode = startSseEpisode('global', 'global|1||')
        vi.advanceTimersByTime(300)
        episode.noteConnect('sub-123', true)
        episode.noteEvent(120)
        episode.noteEvent(80)
        vi.advanceTimersByTime(2_500)
        episode.end('transport-error')

        const events = episodeEvents()
        expect(events).toHaveLength(1)
        expect(events[0]).toMatchObject({
            scope: 'global',
            subscriptionId: 'sub-123',
            resume: 'ok',
            connectMs: 300,
            durationMs: 2_800,
            eventsCount: 2,
            bytesSent: 200,
            disconnectReason: 'transport-error',
        })
        expectSchemaValid('sse_episode', events[0])
    })

    it('end is idempotent (requestReconnect + effect cleanup both call it)', () => {
        const episode = startSseEpisode('global', 'global|1||')
        episode.noteConnect(null, true)
        episode.end('closed')
        episode.end('unsubscribe')
        expect(episodeEvents()).toHaveLength(1)
        expect(episodeEvents()[0]).toMatchObject({ disconnectReason: 'closed' })
    })

    it('same-subscription reconnect without resume = gap anomaly + gap fields on the episode', () => {
        const first = startSseEpisode('global', 'global|1||')
        first.noteConnect('sub-1', true)
        vi.advanceTimersByTime(10_000)
        first.end('heartbeat-timeout')

        vi.advanceTimersByTime(4_000) // the outage
        const second = startSseEpisode('global', 'global|1||')
        second.noteConnect('sub-2', false)

        const gaps = anomalyEvents('gap')
        expect(gaps).toHaveLength(1)
        expect(gaps[0]).toMatchObject({ outageMs: 4_000, resumedAfterGap: true })
        expectSchemaValid('sse_anomaly', gaps[0])

        second.noteEvent(10)
        second.end('unsubscribe')
        const secondRow = episodeEvents()[1]
        expect(secondRow).toMatchObject({ resume: 'gap', gapMs: 4_000, eventsCount: 1, disconnectReason: 'unsubscribe' })
    })

    it('a session switch (different subscription) is not a gap', () => {
        const first = startSseEpisode('full', 'full|0|session-a|')
        first.noteConnect('sub-1', true)
        first.end('unsubscribe')

        const next = startSseEpisode('full', 'full|0|session-b|')
        next.noteConnect('sub-2', false)
        expect(anomalyEvents('gap')).toHaveLength(0)
        next.end('unsubscribe')
        expect(episodeEvents()[1]).toMatchObject({ resume: 'ok' })
    })

    it('first-ever connect without resume is not a gap (older hubs omit the field)', () => {
        const episode = startSseEpisode('global', 'global|1||')
        episode.noteConnect(null, false)
        expect(anomalyEvents('gap')).toHaveLength(0)
    })
})

describe('disconnect anomaly + reconnect storm', () => {
    it('captures each disconnect with reason and hidden-at-drop', () => {
        noteSseDisconnected('global', 'transport-error', true)
        const events = anomalyEvents('disconnect')
        expect(events).toHaveLength(1)
        expect(events[0]).toEqual({ anomaly: 'disconnect', reason: 'transport-error', hiddenAtDrop: true })
        expectSchemaValid('sse_anomaly', events[0])
    })

    it(`emits one storm at ${SSE_STORM_THRESHOLD} disconnects inside the 5-minute window, then re-arms`, () => {
        noteSseDisconnected('global', 'transport-error', false)
        vi.advanceTimersByTime(60_000)
        noteSseDisconnected('global', 'heartbeat-timeout', false)
        expect(anomalyEvents('reconnect-storm')).toHaveLength(0)
        vi.advanceTimersByTime(60_000)
        noteSseDisconnected('global', 'closed', false)
        expect(anomalyEvents('reconnect-storm')).toHaveLength(1)
        expect(anomalyEvents('disconnect')).toHaveLength(3)

        // window reset: two more drops do not re-trigger, the third does
        vi.advanceTimersByTime(60_000)
        noteSseDisconnected('global', 'transport-error', false)
        vi.advanceTimersByTime(60_000)
        noteSseDisconnected('global', 'transport-error', false)
        expect(anomalyEvents('reconnect-storm')).toHaveLength(1)
        vi.advanceTimersByTime(60_000)
        noteSseDisconnected('global', 'transport-error', false)
        expect(anomalyEvents('reconnect-storm')).toHaveLength(2)
    })

    it('storms are tracked per scope', () => {
        for (let i = 0; i < SSE_STORM_THRESHOLD; i += 1) {
            noteSseDisconnected('global', 'closed', false)
        }
        expect(anomalyEvents('reconnect-storm')).toHaveLength(1)
        noteSseDisconnected('full', 'closed', false)
        noteSseDisconnected('full', 'closed', false)
        expect(anomalyEvents('reconnect-storm')).toHaveLength(1) // full scope still below threshold
    })
})

describe('stall predicate (semantic: only in-turn silence)', () => {
    it('fires after 30s of thinking-phase silence with stallMs', () => {
        armSessionStall('s1')
        noteSessionThinking('s1', true)
        vi.advanceTimersByTime(SSE_STALL_MS - 100)
        expect(anomalyEvents('stall')).toHaveLength(0)
        vi.advanceTimersByTime(200)
        const stalls = anomalyEvents('stall')
        expect(stalls).toHaveLength(1)
        // fires exactly at the deadline
        expect(stalls[0]).toEqual({ anomaly: 'stall', stallMs: SSE_STALL_MS })
        expectSchemaValid('sse_anomaly', stalls[0])
    })

    it('does not fire outside a turn (thinking=false or not armed)', () => {
        armSessionStall('s1')
        noteSessionThinking('s1', true)
        noteSessionThinking('s1', false) // turn ended before the threshold
        vi.advanceTimersByTime(120_000)
        expect(anomalyEvents('stall')).toHaveLength(0)

        noteSessionThinking('s2', true) // never armed (no session subscription)
        vi.advanceTimersByTime(120_000)
        expect(anomalyEvents('stall')).toHaveLength(0)
    })

    it('a received message clears the stall clock and re-arms it', () => {
        armSessionStall('s1')
        noteSessionThinking('s1', true)
        vi.advanceTimersByTime(20_000)
        noteSessionMessage('s1') // pipe alive: silence clock restarts
        vi.advanceTimersByTime(25_000) // 45s since turn start, 25s since message
        expect(anomalyEvents('stall')).toHaveLength(0)
        vi.advanceTimersByTime(SSE_STALL_MS)
        const stalls = anomalyEvents('stall')
        expect(stalls).toHaveLength(1)
        expect(stalls[0]).toMatchObject({ stallMs: SSE_STALL_MS })
    })

    it('disarm (session close / subscription teardown) drops the tracker', () => {
        armSessionStall('s1')
        noteSessionThinking('s1', true)
        disarmSessionStall('s1')
        vi.advanceTimersByTime(120_000)
        expect(anomalyEvents('stall')).toHaveLength(0)
    })
})
