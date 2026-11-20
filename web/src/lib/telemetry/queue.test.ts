import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { TelemetryEvent } from '@hapi/protocol/telemetry'
import { captureEvent, queuedEventsForTest } from './queue'
import { appendOutbox, readOutbox } from './outbox'
import { probeCapability } from './negotiate'
import { state } from './state'
import {
    forceEnableTelemetryForTest,
    installForTest,
    resetTelemetryForTest,
    resetTelemetryMachineForTest,
    stubTelemetryFetch,
    type TelemetryFetchKit,
} from './testHelpers'

/**
 * Queue core: three flush thresholds, the 500-event cap, exponential backoff,
 * outbox persistence/cap and the pagehide keepalive slicing.
 */

let kit: TelemetryFetchKit

beforeEach(() => {
    vi.useFakeTimers()
    kit = stubTelemetryFetch({ level: 1 })
    installForTest(kit)
})

afterEach(() => {
    kit.restore()
    resetTelemetryForTest()
    vi.useRealTimers()
})

function eventPosts(): number {
    return kit.requests.filter((r) => r.url.includes('/api/telemetry/events')).length
}

async function settle(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0)
}

function captureSlow(n: number, durationMs = 5): void {
    for (let i = 0; i < n; i++) {
        captureEvent('diag', 'load_slow', { phase: 'session-detail', durationMs, fromCache: false })
    }
}

/** Change the negotiated level the way a hub settings change would. */
async function negotiateLevel(n: number): Promise<void> {
    kit.setLevel(n)
    await probeCapability()
    await settle()
}

describe('flush thresholds', () => {
    it('negotiates capability at install and enables capture', async () => {
        await settle()
        expect(state.enabled).toBe(true)
        expect(state.level).toBe(1)
    })

    it('flushes at 32 events in a single batch', async () => {
        await settle()
        captureSlow(31)
        await settle()
        expect(eventPosts()).toBe(0)
        captureSlow(1)
        await settle()
        expect(eventPosts()).toBe(1)
        expect(kit.batches[0]?.events).toHaveLength(32)
        expect(kit.batches[0]?.schema).toBe(1)
        expect(queuedEventsForTest()).toHaveLength(0)
    })

    it('auto-fills id/ts/seq/level from the kind registry', async () => {
        await settle()
        captureSlow(32)
        await settle()
        const events = kit.batches[0]?.events as TelemetryEvent[]
        const ids = new Set(events.map((e) => e.id))
        expect(ids.size).toBe(32)
        expect(events[0]?.seq).toBe(0)
        expect(events[31]?.seq).toBe(31)
        expect(events.every((e) => e.domain === 'diag' && e.kind === 'load_slow' && e.level === 1)).toBe(true)
        expect(events.every((e) => typeof e.ts === 'number')).toBe(true)
    })

    it('flushes at 24 KiB accumulated bytes with fewer than 32 events (L2 web_vital payloads)', async () => {
        await negotiateLevel(2)
        const bigJson = 'x'.repeat(3500)
        for (let i = 0; i < 7; i++) {
            captureEvent('perf', 'web_vital', { cls: 0.01, longTasks: 1, slowestJson: bigJson })
        }
        expect(queuedEventsForTest().length).toBeLessThan(32)
        await settle()
        expect(eventPosts()).toBe(1)
        expect(kit.batches[0]?.events).toHaveLength(7)
        expect(JSON.stringify(kit.batches[0]).length).toBeGreaterThan(24 * 1024)
    })

    it('flushes the oldest event at 60s on L1', async () => {
        await settle()
        captureSlow(1)
        await vi.advanceTimersByTimeAsync(59_999)
        expect(eventPosts()).toBe(0)
        await vi.advanceTimersByTimeAsync(1)
        expect(eventPosts()).toBe(1)
    })

    it('flushes at 30s on L2+', async () => {
        await negotiateLevel(2)
        captureSlow(1)
        await vi.advanceTimersByTimeAsync(29_999)
        expect(eventPosts()).toBe(0)
        await vi.advanceTimersByTimeAsync(1)
        expect(eventPosts()).toBe(1)
    })

    it('caps batches at 64 events per POST', async () => {
        await settle()
        state.flushing = true // block the threshold flush to accumulate
        captureSlow(100)
        state.flushing = false
        void import('./queue').then(({ flushQueue }) => flushQueue('manual'))
        await settle()
        await settle()
        expect(eventPosts()).toBe(2)
        expect(kit.batches[0]?.events).toHaveLength(64)
        expect(kit.batches[1]?.events).toHaveLength(36)
    })

    it('normal flush sends a plain (non-keepalive) POST — keepalive bodies cap at ~64 KiB', async () => {
        // A ≤200 KiB batch on a keepalive fetch throws TypeError at the engine
        // level → the whole batch would park in the outbox in an infinite
        // offline-recovery loop. Only the pagehide slices (≤48 KiB) keepalive.
        await settle()
        captureSlow(32)
        await settle()
        expect(eventPosts()).toBe(1)
        const init = kit.requests.find((r) => r.url.includes('/api/telemetry/events'))?.init as RequestInit
        expect(init.keepalive ?? false).toBe(false)
    })
})

describe('queue cap', () => {
    it('drops the oldest at 500 events and reports droppedOldest honesty meta', async () => {
        await settle()
        state.flushing = true
        captureSlow(600)
        expect(queuedEventsForTest()).toHaveLength(500)
        expect(state.droppedOldest).toBe(100)
        const seqs = queuedEventsForTest().map((e) => e.seq)
        expect(seqs[0]).toBe(100)
        expect(seqs[499]).toBe(599)
        state.flushing = false
        void import('./queue').then(({ flushQueue }) => flushQueue('manual'))
        await settle()
        await settle()
        expect(eventPosts()).toBeGreaterThan(0)
        expect(kit.batches[0]?.meta?.droppedOldest).toBe(100)
    })
})

describe('backoff and outbox', () => {
    it('retries with exponential backoff 1s→2s→4s and parks events in the outbox', async () => {
        await settle()
        kit.failEvents('network')
        captureSlow(32)
        await settle() // first flush fails
        expect(eventPosts()).toBe(1)
        expect(queuedEventsForTest()).toHaveLength(0)
        expect(readOutbox().events).toHaveLength(32)

        await vi.advanceTimersByTimeAsync(1_000)
        expect(eventPosts()).toBe(2)
        await vi.advanceTimersByTimeAsync(1_999)
        expect(eventPosts()).toBe(2)
        await vi.advanceTimersByTimeAsync(1)
        expect(eventPosts()).toBe(3)
        await vi.advanceTimersByTimeAsync(4_000)
        expect(eventPosts()).toBe(4)

        // Recovery: the next retry succeeds and drains the outbox.
        kit.failEvents('off')
        await vi.advanceTimersByTimeAsync(8_000)
        expect(eventPosts()).toBe(5)
        expect(readOutbox().events).toHaveLength(0)
        expect(kit.batches.at(-1)?.events).toHaveLength(32)
        expect(state.flushFailures).toBe(0)
    })

    it('drops the batch terminally on 400/413 and stays enabled', async () => {
        await settle()
        kit.setEventsStatus(413)
        captureSlow(32)
        await settle()
        expect(eventPosts()).toBe(1)
        expect(readOutbox().events).toHaveLength(0)
        expect(queuedEventsForTest()).toHaveLength(0)
        expect(state.enabled).toBe(true)
    })

    it('disables and re-probes after a 404 (old hub)', async () => {
        await settle()
        kit.setEventsStatus(404)
        captureSlow(32)
        await settle()
        expect(state.enabled).toBe(false)
        expect(readOutbox().events).toHaveLength(0)
        // 30min later the probe re-enables and a capture flows again.
        await vi.advanceTimersByTimeAsync(30 * 60_000)
        await settle()
        expect(state.enabled).toBe(true)
        kit.setEventsStatus(200)
        captureSlow(1)
        await vi.advanceTimersByTimeAsync(60_000)
        expect(eventPosts()).toBe(2)
    })

    it('persists outbox across reloads: seq seeding and redelivery', async () => {
        await settle()
        kit.failEvents('network')
        captureSlow(32) // threshold flush fails → events parked in the outbox
        await settle()
        expect(readOutbox().events).toHaveLength(32)
        const maxSeq = Math.max(...readOutbox().events.map((e) => e.seq))

        // Simulated reload: machine reset only — localStorage survives.
        kit.failEvents('off')
        resetTelemetryMachineForTest()
        forceEnableTelemetryForTest()
        const { installTelemetry } = await import('./index')
        installTelemetry({ getAuthToken: () => 'jwt-again', baseUrl: 'https://hub.example' })
        expect(state.seq).toBe(maxSeq + 1)
        await settle()
        // Freshly negotiated → outbox drained in one POST.
        const post = kit.batches.at(-1)
        expect(post?.events).toHaveLength(32)
        expect(readOutbox().events).toHaveLength(0)
    })
})

describe('client size gate (UTF-8) and hub honesty counters', () => {
    it('rejects CJK events whose UTF-8 bytes exceed the hub data cap — before the wire', async () => {
        await settle()
        // 1300 CJK chars = 3900 UTF-8 bytes: passes any UTF-16 length count,
        // exceeds the 3900-byte whole-event ceiling (hub would 200+reject it).
        captureEvent('diag', 'load_slow', { phase: 'session-detail', durationMs: 1, fromCache: false, pad: '中'.repeat(1300) })
        expect(queuedEventsForTest()).toHaveLength(0)
        // Same code-unit count in ASCII is well under the cap and flows.
        captureEvent('diag', 'load_slow', { phase: 'session-detail', durationMs: 1, fromCache: false, pad: 'a'.repeat(1300) })
        expect(queuedEventsForTest()).toHaveLength(1)
    })

    it('accumulates hub-reported rejected/droppedByLevel counts and surfaces them in the next batch meta', async () => {
        await settle()
        captureSlow(32)
        await settle()
        expect(eventPosts()).toBe(1)
        expect(state.serverRejected).toBe(0)

        kit.setIngestResult({ accepted: 30, rejected: 2, droppedByLevel: 1 })
        captureSlow(32)
        await settle()
        expect(eventPosts()).toBe(2)
        expect(state.serverRejected).toBe(2)
        expect(state.serverDroppedByLevel).toBe(1)
        // learned from response #2 — carried by batch #3's meta, not #2's
        expect(kit.batches[1]?.meta?.serverRejected).toBeUndefined()

        captureSlow(32)
        await settle()
        expect(eventPosts()).toBe(3)
        expect(kit.batches[2]?.meta?.serverRejected).toBe(2)
        expect(kit.batches[2]?.meta?.serverDroppedByLevel).toBe(1)
        // schema rejections are permanent: nothing is parked for retry
        expect(readOutbox().events).toHaveLength(0)
        expect(queuedEventsForTest()).toHaveLength(0)
    })
})

describe('pagehide', () => {
    it('slices keepalive POSTs at 64 events and writes everything to the outbox', async () => {
        await settle()
        state.flushing = true
        captureSlow(70)
        state.flushing = false
        window.dispatchEvent(new Event('pagehide'))
        await settle()
        const posts = kit.requests.filter((r) => r.url.includes('/api/telemetry/events'))
        expect(posts).toHaveLength(2)
        expect(kit.batches[0]?.events).toHaveLength(64)
        expect(kit.batches[1]?.events).toHaveLength(6)
        for (const post of posts) {
            expect((post.init as { keepalive?: boolean }).keepalive).toBe(true)
        }
        // Everything is parked for idempotent redelivery; memory queue is empty.
        expect(readOutbox().events).toHaveLength(70)
        expect(queuedEventsForTest()).toHaveLength(0)
    })

    it('captures arriving after pagehide go straight to the outbox (late-listener ordering)', async () => {
        // SessionPage's tracker listens AFTER the SDK, so its session_close
        // ('pagehide') capture lands after the flush — the memory queue would
        // never deliver it. The outbox must catch it.
        await settle()
        window.dispatchEvent(new Event('pagehide'))
        captureEvent('ux', 'session_close', { wallDwellMs: 1_500, visibleDwellMs: 1_000, exit: 'pagehide' })
        expect(queuedEventsForTest()).toHaveLength(0)
        const outbox = readOutbox().events
        expect(outbox).toHaveLength(1)
        expect(outbox[0]?.kind).toBe('session_close')
        expect((outbox[0]?.data as { exit?: string }).exit).toBe('pagehide')
    })

    it('keeps each slice under 48 KiB for large payloads', async () => {
        await negotiateLevel(2)
        state.flushing = true
        const bigJson = 'y'.repeat(3500)
        for (let i = 0; i < 20; i++) {
            captureEvent('perf', 'web_vital', { cls: 0.01, longTasks: 1, slowestJson: bigJson })
        }
        state.flushing = false
        window.dispatchEvent(new Event('pagehide'))
        await settle()
        expect(kit.batches.length).toBeGreaterThan(1)
        for (const batch of kit.batches) {
            expect(JSON.stringify(batch).length).toBeLessThanOrEqual(48 * 1024)
        }
    })
})

describe('outbox cap', () => {
    it('trims oldest events at the 256 KiB hard cap', () => {
        const events: TelemetryEvent[] = []
        for (let i = 0; i < 200; i++) {
            events.push({
                id: `cap-${i}`,
                ts: 1,
                seq: i,
                domain: 'diag',
                kind: 'load_slow',
                level: 1,
                data: { phase: 'session-detail', durationMs: 1, fromCache: false, pad: 'z'.repeat(1200) },
            })
        }
        appendOutbox(events)
        const stored = readOutbox()
        expect(stored.events.length).toBeLessThan(200)
        expect(stored.events.length).toBeGreaterThan(0)
        expect(stored.droppedOldest).toBe(200 - stored.events.length)
        expect(stored.events.at(-1)?.id).toBe('cap-199')
        expect(stored.events[0]?.id).not.toBe('cap-0')
        const raw = localStorage.getItem('hapi:telemetry:outbox:v1') ?? ''
        expect(raw.length).toBeLessThanOrEqual(256 * 1024)
    })

    it('ignores malformed outbox content', () => {
        localStorage.setItem('hapi:telemetry:outbox:v1', '{not json')
        expect(readOutbox().events).toHaveLength(0)
        localStorage.setItem('hapi:telemetry:outbox:v1', JSON.stringify({ v: 2, events: [{}] }))
        expect(readOutbox().events).toHaveLength(0)
    })
})

describe('immediate flush on hidden/online', () => {
    it('flushes on visibilitychange→hidden and online', async () => {
        await settle()
        captureSlow(1)
        Object.defineProperty(document, 'hidden', { configurable: true, value: true })
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
        document.dispatchEvent(new Event('visibilitychange'))
        await settle()
        expect(eventPosts()).toBe(1)

        captureSlow(1)
        window.dispatchEvent(new Event('online'))
        await settle()
        expect(eventPosts()).toBe(2)
    })
})
