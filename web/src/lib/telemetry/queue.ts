import {
    TELEMETRY_KINDS,
    TELEMETRY_MAX_EVENTS_PER_BATCH,
    type TelemetryBatch,
    type TelemetryDomain,
    type TelemetryEvent,
} from '@hapi/protocol/telemetry'
import { resolveDeviceKind, resolveLiveBaseUrl, resolveOriginKind, randomTelemetryId, telemetryAppVersion } from './device'
import { onFlushSuccessMaybeRefreshLevel, probeCapability, resolveBearerToken } from './negotiate'
import { appendOutbox, readOutbox, removeFromOutbox } from './outbox'
import { postTelemetryBatch } from './uplink'
import {
    BACKOFF_MAX_MS,
    BACKOFF_START_MS,
    BATCH_BYTES_CEILING,
    FLUSH_AGE_MS_L1,
    FLUSH_AGE_MS_L2PLUS,
    FLUSH_BYTES_THRESHOLD,
    FLUSH_COUNT_THRESHOLD,
    MAX_QUEUE_EVENTS,
    PAGEHIDE_SLICE_BYTES,
    RETRY_PROBE_MS,
    state,
    type QueuedEvent,
    type TelemetryCaptureOpts,
} from './state'

/**
 * Queue core: capture gating (installed / capability / level / kind registry),
 * the three flush thresholds (≥32 events / ≥24 KiB / oldest-event age 60s at
 * L1, 30s at L2+ — ruling 12), exponential backoff (1s → … → 5min cap) and
 * the localStorage outbox. Immediate flush on hidden/pagehide/online is wired
 * in installers.ts; pagehide slicing lives here.
 *
 * Every entry point is fail-silent (§7.2 risk 2): a telemetry bug must never
 * become an app bug.
 */

const ENVELOPE_OVERHEAD_BYTES = 512

/**
 * Whole-event serialized size gate, in UTF-8 BYTES. The hub enforces
 * TELEMETRY_MAX_EVENT_DATA_BYTES (4 KiB) on the wire encoding; counting
 * UTF-16 code units here let CJK events (3 bytes/char vs 1 unit) land in the
 * gap between the client cap and the hub rejection. 3900 leaves room for the
 * envelope (id/ts/seq/domain/kind/level ≈ 200 B) under the 4096 data cap.
 */
const EVENT_TOTAL_BYTES_CEILING = 3900

const utf8 = new TextEncoder()

function utf8Bytes(s: string): number {
    try {
        return utf8.encode(s).byteLength
    } catch {
        return s.length
    }
}

class RetryableFlushError extends Error {}

function currentDevice(): TelemetryBatch['device'] {
    const baseUrl = resolveLiveBaseUrl(state.config?.baseUrl ?? '')
    return {
        id: state.deviceId ?? randomTelemetryId(),
        kind: resolveDeviceKind(),
        origin: resolveOriginKind(baseUrl),
    }
}

function buildBatch(events: readonly TelemetryEvent[]): TelemetryBatch {
    const meta: TelemetryBatch['meta'] = {}
    if (state.droppedOldest > 0) meta.droppedOldest = state.droppedOldest
    if (state.flushFailures > 0) meta.flushFailures = state.flushFailures
    if (state.serverRejected > 0) meta.serverRejected = state.serverRejected
    if (state.serverDroppedByLevel > 0) meta.serverDroppedByLevel = state.serverDroppedByLevel
    return {
        schema: 1,
        device: currentDevice(),
        appVersion: telemetryAppVersion(),
        events: [...events],
        meta,
    }
}

export function captureEvent(domain: TelemetryDomain, kind: string, data: Record<string, unknown>, opts?: TelemetryCaptureOpts): void {
    try {
        if (!state.installed || !state.enabled || state.level <= 0) return
        const spec = TELEMETRY_KINDS[kind]
        if (!spec || spec.domain !== domain) return
        if (spec.minLevel > state.level) return
        const safeData = typeof data === 'object' && data !== null ? data : {}
        const event: TelemetryEvent = {
            id: randomTelemetryId(),
            ts: Date.now(),
            seq: state.seq++,
            domain,
            kind,
            level: spec.minLevel,
            data: safeData,
        }
        if (opts?.severity === 'error' || opts?.severity === 'warn' || opts?.severity === 'info') {
            event.severity = opts.severity
        }
        if (typeof opts?.sessionId === 'string' && opts.sessionId) event.sessionId = opts.sessionId.slice(0, 128)
        if (typeof opts?.fingerprint === 'string' && opts.fingerprint) event.fingerprint = opts.fingerprint.slice(0, 120)
        let serialized: string
        try {
            serialized = JSON.stringify(event)
        } catch {
            return // unserializable payload — never let it near the queue
        }
        const bytes = utf8Bytes(serialized)
        if (!serialized || bytes > EVENT_TOTAL_BYTES_CEILING) return
        if (state.unloading) {
            // pagehide already flushed: a capture arriving in the same event
            // loop (SessionPage's tracker listens AFTER the SDK) would sit in
            // the memory queue forever — park it in the outbox for the next
            // load's negotiated flush instead.
            appendOutbox([event])
            return
        }
        state.queue.push({ ev: event, bytes })
        state.queueBytes += bytes
        while (state.queue.length > MAX_QUEUE_EVENTS) {
            const dropped = state.queue.shift()
            if (!dropped) break
            state.queueBytes -= dropped.bytes
            state.droppedOldest += 1
        }
        scheduleAgeTimer()
        if (state.queue.length >= FLUSH_COUNT_THRESHOLD || state.queueBytes >= FLUSH_BYTES_THRESHOLD) {
            void flushQueue('threshold')
        }
    } catch {
        // fail-silent
    }
}

function ageLimitMs(): number {
    return state.level >= 2 ? FLUSH_AGE_MS_L2PLUS : FLUSH_AGE_MS_L1
}

function clearAgeTimer(): void {
    if (state.ageTimer !== null) {
        clearTimeout(state.ageTimer)
        state.ageTimer = null
    }
    state.ageTimerDue = undefined
}

function scheduleAgeTimer(): void {
    try {
        if (state.queue.length === 0) {
            clearAgeTimer()
            return
        }
        const oldestTs = state.queue[0]?.ev.ts ?? Date.now()
        const dueIn = oldestTs + ageLimitMs() - Date.now()
        if (dueIn <= 0) {
            void flushQueue('age')
            return
        }
        if (state.ageTimer === null || (state.ageTimerDue !== undefined && dueIn < state.ageTimerDue)) {
            clearAgeTimer()
            state.ageTimerDue = dueIn
            state.ageTimer = setTimeout(() => {
                state.ageTimer = null
                state.ageTimerDue = undefined
                void flushQueue('age')
            }, dueIn)
        }
    } catch {
        // fail-silent
    }
}

function scheduleRetryFlush(): void {
    try {
        if (state.retryTimer !== null) clearTimeout(state.retryTimer)
        const delay = Math.min(BACKOFF_START_MS * 2 ** state.flushFailures, BACKOFF_MAX_MS)
        state.flushFailures += 1
        state.retryTimer = setTimeout(() => {
            state.retryTimer = null
            void flushQueue('retry')
        }, delay)
    } catch {
        // fail-silent
    }
}

function scheduleProbeRetry(): void {
    try {
        if (state.probeTimer !== null) clearTimeout(state.probeTimer)
        state.probeTimer = setTimeout(() => {
            state.probeTimer = null
            void probeCapability()
        }, RETRY_PROBE_MS)
    } catch {
        // fail-silent
    }
}

/** Everything awaiting delivery (outbox ∪ memory queue ∪ in-flight POST),
 *  deduped by idempotency key and oldest-first. */
function mergedPendingEvents(): TelemetryEvent[] {
    const byId = new Map<string, TelemetryEvent>()
    for (const ev of readOutbox().events) byId.set(ev.id, ev)
    for (const { ev } of state.queue) byId.set(ev.id, ev)
    for (const ev of state.inFlight) byId.set(ev.id, ev)
    return [...byId.values()].sort((a, b) => a.seq - b.seq)
}

function removeFromMemory(ids: readonly string[]): void {
    const idSet = new Set(ids)
    const kept: QueuedEvent[] = []
    let bytes = 0
    for (const entry of state.queue) {
        if (idSet.has(entry.ev.id)) continue
        kept.push(entry)
        bytes += entry.bytes
    }
    state.queue = kept
    state.queueBytes = bytes
}

function estimateEventBytes(ev: TelemetryEvent): number {
    try {
        const s = JSON.stringify(ev)
        return s ? utf8Bytes(s) : 1024
    } catch {
        return 1024
    }
}

/** Take the next batch: ≤64 events, ≤BATCH_BYTES_CEILING serialized. */
function takeBatch(pending: readonly TelemetryEvent[]): TelemetryEvent[] {
    const events: TelemetryEvent[] = []
    let bytes = 0
    for (const ev of pending) {
        if (events.length >= TELEMETRY_MAX_EVENTS_PER_BATCH) break
        const evBytes = estimateEventBytes(ev)
        if (events.length > 0 && bytes + evBytes > BATCH_BYTES_CEILING) break
        events.push(ev)
        bytes += evBytes
    }
    return events
}

interface IngestResult {
    level?: unknown
    accepted?: number
    rejected?: number
    droppedByLevel?: number
}

async function readIngestResult(res: Response): Promise<IngestResult> {
    try {
        const body = (await res.json()) as { level?: unknown; accepted?: unknown; rejected?: unknown; droppedByLevel?: unknown }
        return {
            level: body?.level,
            accepted: typeof body?.accepted === 'number' ? body.accepted : 0,
            rejected: typeof body?.rejected === 'number' ? body.rejected : 0,
            droppedByLevel: typeof body?.droppedByLevel === 'number' ? body.droppedByLevel : 0,
        }
    } catch {
        return {}
    }
}

/**
 * Drain loop: deliver everything pending (outbox + queue) in ≤64-event /
 * ≤200 KiB batches. Re-merges after every await so captures that arrive
 * mid-flush join the same drain. Retryable failures park the remainder in
 * the outbox and reschedule with exponential backoff; terminal 4xx drops the
 * batch (404/410 additionally reverts to disabled until the next probe).
 */
export async function flushQueue(reason: string): Promise<void> {
    void reason
    try {
        if (!state.installed || !state.enabled || state.level <= 0) return
        if (state.flushing) return
        state.flushing = true
        try {
            let guard = 0
            while (guard++ < 1000) {
                const pending = mergedPendingEvents()
                if (pending.length === 0) break
                const events = takeBatch(pending)
                if (events.length === 0) break
                const ids = events.map((ev) => ev.id)
                state.inFlight = events
                let res: Response
                try {
                    // Normal flush: plain fetch — the page is alive, a failure
                    // retries with backoff. keepalive bodies cap at ~64 KiB at
                    // the engine level, which a ≤200 KiB batch would violate
                    // (TypeError → the whole batch parks in the outbox in an
                    // infinite offline-recovery loop). Only the pagehide
                    // slices (≤48 KiB) below use keepalive.
                    res = await postTelemetryBatch(buildBatch(events), false)
                } catch {
                    throw new RetryableFlushError()
                }
                if (res.ok) {
                    const ingest = await readIngestResult(res)
                    removeFromMemory(ids)
                    removeFromOutbox(ids)
                    state.inFlight = []
                    state.droppedOldest = 0
                    state.flushFailures = 0
                    // Server-side honesty counters: events the hub rejected
                    // (schema) or dropped (level) inside a 200 are permanent —
                    // they are counted and surfaced in the next batch meta,
                    // never re-sent.
                    state.serverRejected += ingest.rejected ?? 0
                    state.serverDroppedByLevel += ingest.droppedByLevel ?? 0
                    onFlushSuccessMaybeRefreshLevel(ingest.level)
                    continue
                }
                if (res.status === 400 || res.status === 413 || res.status === 404 || res.status === 410) {
                    // Terminal: invalid envelope / oversized body / endpoint gone.
                    // Drop the batch — it must never be re-sent. A missing
                    // endpoint also reverts to disabled until the next probe.
                    removeFromMemory(ids)
                    removeFromOutbox(ids)
                    state.inFlight = []
                    state.flushFailures += 1
                    if (res.status === 404 || res.status === 410) {
                        state.enabled = false
                        state.level = 0
                        scheduleProbeRetry()
                        return
                    }
                    continue
                }
                // 401 (stale token) / 429 / 5xx — retryable with backoff.
                throw new RetryableFlushError()
            }
        } finally {
            state.inFlight = []
            state.flushing = false
        }
        state.flushFailures = 0
        scheduleAgeTimer()
    } catch {
        // Retryable failure: park everything not yet delivered in the outbox
        // and retry with exponential backoff.
        try {
            const remaining = mergedPendingEvents()
            if (remaining.length > 0) {
                appendOutbox(remaining)
                removeFromMemory(remaining.map((ev) => ev.id))
            }
        } catch {
            // fail-silent
        }
        scheduleRetryFlush()
    }
}

/** Finish any in-flight http observations so they join this flush. */
export function drainPendingHttpObservations(): void {
    try {
        const pending = [...state.pendingHttp]
        state.pendingHttp.clear()
        for (const observation of pending) observation.finish()
    } catch {
        // fail-silent
    }
}

/**
 * pagehide: synchronous best-effort delivery. Slices into ≤48 KiB keepalive
 * POSTs (the 64 KiB wire cap leaves header headroom); EVERY pending event is
 * also written to the outbox — keepalive delivery is unconfirmed, and the
 * hub's idempotency keys (INSERT OR IGNORE) make re-delivery harmless (§3.2-2).
 */
export function flushPageHideNow(): void {
    try {
        // Terminal lifetime marker: captures arriving after this point (same
        // event loop — e.g. SessionPage's tracker, registered later than the
        // SDK) are written straight to the outbox by captureEvent.
        state.unloading = true
        if (!state.installed || !state.enabled) return
        drainPendingHttpObservations()
        const pending = mergedPendingEvents()
        if (pending.length === 0) return
        let index = 0
        while (index < pending.length) {
            const slice: TelemetryEvent[] = []
            let bytes = 0
            while (index < pending.length && slice.length < TELEMETRY_MAX_EVENTS_PER_BATCH) {
                const ev = pending[index]
                if (ev === undefined) break
                const evBytes = estimateEventBytes(ev)
                if (slice.length > 0 && bytes + evBytes > PAGEHIDE_SLICE_BYTES - ENVELOPE_OVERHEAD_BYTES) break
                slice.push(ev)
                bytes += evBytes
                index += 1
            }
            if (slice.length === 0) break
            try {
                void postTelemetryBatch(buildBatch(slice), true)
            } catch {
                break // keepalive quota exhausted — the outbox below is the net
            }
        }
        // Memory queue empties into the outbox; the idempotency keys make the
        // possibly-duplicated keepalive delivery safe.
        appendOutbox(pending)
        state.queue = []
        state.queueBytes = 0
        clearAgeTimer()
    } catch {
        // fail-silent
    }
}

/** Test-only introspection: events currently sitting in the memory queue. */
export function queuedEventsForTest(): TelemetryEvent[] {
    return state.queue.map(({ ev }) => ev)
}
