import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TELEMETRY_KINDS } from '@hapi/protocol/telemetry'
import {
    VISIT_HIDDEN_TIMEOUT_MS,
    createVisitTracker,
    recordSessionEntry,
    resetSessionVisitTelemetryForTests,
    resolveOpenEntry,
    type VisitCaptureFn,
} from './sessionVisitTelemetry'

vi.mock('@/lib/telemetryClient', () => ({
    telemetryClient: { capture: vi.fn(), setTrigger: vi.fn() },
    bindTelemetryClient: vi.fn(),
}))

import { telemetryClient } from '@/lib/telemetryClient'

const setTriggerMock = vi.mocked(telemetryClient.setTrigger)

type Captured = { kind: string; data: Record<string, unknown> }

function makeCaptureLog(log: Captured[]): VisitCaptureFn {
    return (kind, data) => {
        log.push({ kind, data })
    }
}

function expectSchemaValid(kind: string, data: unknown): void {
    const spec = TELEMETRY_KINDS[kind]
    expect(spec, `kind ${kind} must be registered`).toBeDefined()
    const parsed = spec!.data.safeParse(data)
    if (!parsed.success) {
        throw new Error(`schema violation for ${kind}: ${JSON.stringify(parsed.error.issues)}`)
    }
}

function setVisibility(state: 'visible' | 'hidden'): void {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: state })
}

let log: Captured[]

beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-20T10:00:00Z'))
    resetSessionVisitTelemetryForTests()
    setTriggerMock.mockClear()
    setVisibility('visible')
    log = []
})

afterEach(() => {
    vi.useRealTimers()
})

describe('entry resolution (registry + URL params)', () => {
    it('maps handleSelectSession branches to entry codes and consumes once', () => {
        recordSessionEntry('s-perm', 'permission-jump')
        recordSessionEntry('s-search', 'search-hit', 'msg-9')
        recordSessionEntry('s-list', 'list-click')

        expect(resolveOpenEntry('s-perm', {})).toEqual({ entry: 'permission-jump' })
        expect(resolveOpenEntry('s-search', {})).toEqual({ entry: 'search-hit', navTargetMessageId: 'msg-9' })
        expect(resolveOpenEntry('s-list', {})).toEqual({ entry: 'list-click' })
        // consumed: a second open of the same session falls back
        expect(resolveOpenEntry('s-perm', {}).entry).toBe('url-direct')
    })

    it('falls back to URL params and then url-direct', () => {
        expect(resolveOpenEntry('s1', { pendingRequestId: 'pr-1' }).entry).toBe('permission-jump')
        expect(resolveOpenEntry('s1', { messageId: 'm-1' })).toEqual({ entry: 'search-hit', navTargetMessageId: 'm-1' })
        expect(resolveOpenEntry('s1', {}).entry).toBe('url-direct')
    })

    it('ignores stale recorded entries', () => {
        recordSessionEntry('s1', 'list-click')
        vi.advanceTimersByTime(31 * 60 * 1000)
        expect(resolveOpenEntry('s1', {}).entry).toBe('url-direct')
    })
})

describe('visit dwell accounting', () => {
    it('accumulates only foreground time across a short background stint', () => {
        const tracker = createVisitTracker({ sessionId: 's1', capture: makeCaptureLog(log) })
        tracker.open('list-click')

        vi.advanceTimersByTime(2_000)
        setVisibility('hidden')
        tracker.onVisibleChange() // pause
        vi.advanceTimersByTime(3_000)
        setVisibility('visible')
        tracker.onVisibleChange() // resume
        vi.advanceTimersByTime(1_000)
        tracker.close('navigate-away')

        const close = log.find((e) => e.kind === 'session_close')
        expect(close).toBeDefined()
        expect(close!.data).toEqual({ wallDwellMs: 6_000, visibleDwellMs: 3_000, exit: 'navigate-away' })
        expectSchemaValid('session_close', close!.data)
    })

    it('emits pause/resume pairs for hidden <= 15min and no close', () => {
        const tracker = createVisitTracker({ sessionId: 's1', capture: makeCaptureLog(log) })
        tracker.open('list-click')

        vi.advanceTimersByTime(4_000)
        setVisibility('hidden')
        tracker.onVisibleChange()
        vi.advanceTimersByTime(5_000)
        setVisibility('visible')
        tracker.onVisibleChange()

        const pause = log.find((e) => e.kind === 'session_pause_resume' && e.data.kind === 'pause')
        const resume = log.find((e) => e.kind === 'session_pause_resume' && e.data.kind === 'resume')
        expect(pause).toBeDefined()
        expect(resume).toBeDefined()
        expect(pause!.data.dwellSoFarMs).toBe(4_000)
        expectSchemaValid('session_pause_resume', pause!.data)
        expect(log.filter((e) => e.kind === 'session_close')).toHaveLength(0)
        expect(log.filter((e) => e.kind === 'session_open')).toHaveLength(1)
    })
})

describe('hidden > 15min visit semantics (PWA long background)', () => {
    it('suspended runtime (timer frozen): timestamp check on visible emits the close+open pair', () => {
        // Mobile long-background: the JS runtime is suspended while hidden, so
        // the 15min setTimeout NEVER fires — only the wall-clock comparison at
        // the visible transition can produce the close+open pair. Simulated
        // with setSystemTime (moves the clock without firing timers).
        const tracker = createVisitTracker({ sessionId: 's1', capture: makeCaptureLog(log) })
        tracker.open('list-click')
        vi.advanceTimersByTime(2_000)

        setVisibility('hidden')
        tracker.onVisibleChange() // pause at visible dwell 2000
        vi.setSystemTime(new Date('2026-11-20T10:16:02Z')) // +16min, timers NOT fired
        expect(log.filter((e) => e.kind === 'session_close')).toHaveLength(0)

        setVisibility('visible')
        tracker.onVisibleChange() // timestamp check → close + synthetic re-open

        const closes = log.filter((e) => e.kind === 'session_close')
        const opens = log.filter((e) => e.kind === 'session_open')
        expect(closes).toHaveLength(1)
        expect(opens).toHaveLength(2)
        expect(closes[0]!.data.exit).toBe('hidden-timeout')
        expect(closes[0]!.data.visibleDwellMs).toBe(2_000)
        // wall dwell runs until the close is emitted — the return moment
        // (16min + 2s), i.e. it includes the whole suspended span
        expect(closes[0]!.data.wallDwellMs).toBe(VISIT_HIDDEN_TIMEOUT_MS + 60_000 + 2_000)
        expectSchemaValid('session_close', closes[0]!.data)
        expect(opens[1]!.data.entry).toBe('resume-after-timeout')
        expectSchemaValid('session_open', opens[1]!.data)

        // The resumed visit starts fresh: dwell after return excludes the
        // background span entirely.
        vi.advanceTimersByTime(5_000)
        tracker.close('navigate-away')
        const finalClose = log.filter((e) => e.kind === 'session_close')[1]
        expect(finalClose).toBeDefined()
        expect(finalClose!.data.wallDwellMs).toBe(5_000)
        expect(finalClose!.data.visibleDwellMs).toBe(5_000)
    })

    it('timer backstop (desktop hidden tab): the timeout fires while hidden, visible then re-opens', () => {
        const tracker = createVisitTracker({ sessionId: 's1', capture: makeCaptureLog(log) })
        tracker.open('list-click')
        vi.advanceTimersByTime(2_000)

        setVisibility('hidden')
        tracker.onVisibleChange() // pause at visible dwell 2000
        vi.advanceTimersByTime(VISIT_HIDDEN_TIMEOUT_MS + 60_000) // timer fires while hidden

        // close already emitted by the timer, before any visible transition
        const closesWhileHidden = log.filter((e) => e.kind === 'session_close')
        expect(closesWhileHidden).toHaveLength(1)
        expect(closesWhileHidden[0]!.data.exit).toBe('hidden-timeout')
        expect(closesWhileHidden[0]!.data.visibleDwellMs).toBe(2_000)
        expect(closesWhileHidden[0]!.data.wallDwellMs).toBe(VISIT_HIDDEN_TIMEOUT_MS + 2_000)

        setVisibility('visible')
        tracker.onVisibleChange() // synthetic re-open

        const opens = log.filter((e) => e.kind === 'session_open')
        expect(opens).toHaveLength(2)
        expect(opens[1]!.data.entry).toBe('resume-after-timeout')
        expect(log.filter((e) => e.kind === 'session_close')).toHaveLength(1)
    })

    it('a return to visible before the timeout keeps the same visit (no close/open)', () => {
        const tracker = createVisitTracker({ sessionId: 's1', capture: makeCaptureLog(log) })
        tracker.open('list-click')
        setVisibility('hidden')
        tracker.onVisibleChange()
        vi.advanceTimersByTime(VISIT_HIDDEN_TIMEOUT_MS - 1_000)
        setVisibility('visible')
        tracker.onVisibleChange()

        expect(log.filter((e) => e.kind === 'session_close')).toHaveLength(0)
        expect(log.filter((e) => e.kind === 'session_open')).toHaveLength(1)
    })
})

describe('close semantics', () => {
    it('pagehide closes once and later cleanups do not double-fire', () => {
        const tracker = createVisitTracker({ sessionId: 's1', capture: makeCaptureLog(log) })
        tracker.open('url-direct')
        vi.advanceTimersByTime(1_500)
        tracker.pageHide()
        tracker.close('navigate-away') // cleanup after pagehide: no-op

        const closes = log.filter((e) => e.kind === 'session_close')
        expect(closes).toHaveLength(1)
        expect(closes[0]!.data.exit).toBe('pagehide')
    })

    it('includes seenTail when provided and drives the fetch-attribution trigger', () => {
        const tracker = createVisitTracker({
            sessionId: 's1',
            capture: makeCaptureLog(log),
            getSeenTail: () => true,
        })
        tracker.open('list-click')
        expect(setTriggerMock).toHaveBeenCalledWith('session-open')
        tracker.close('switch')
        expect(setTriggerMock).toHaveBeenCalledWith(null)
        const close = log.find((e) => e.kind === 'session_close')!
        expect(close.data.seenTail).toBe(true)
        expectSchemaValid('session_close', close.data)
    })

    it('hides without a prior open publish no pause (opened while hidden)', () => {
        setVisibility('hidden')
        const tracker = createVisitTracker({ sessionId: 's1', capture: makeCaptureLog(log) })
        tracker.open('url-direct')
        setVisibility('visible')
        tracker.onVisibleChange()
        expect(log.filter((e) => e.kind === 'session_pause_resume')).toHaveLength(0)
    })
})
