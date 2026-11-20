import type { TelemetryEvent } from '@hapi/protocol/telemetry'
import { OUTBOX_MAX_BYTES, OUTBOX_STORAGE_KEY } from './state'

/**
 * localStorage outbox (ruling 3: localStorage over IndexedDB — synchronous
 * writes are exactly what the pagehide window needs; 256 KiB hard cap).
 *
 * Stored shape: { v: 1, events: [...], droppedOldest: n }. On any parse or
 * storage failure the outbox is treated as empty (fail-silent; the events it
 * held were already failed deliveries — losing them is acceptable).
 */

interface OutboxFile {
    v: 1
    events: TelemetryEvent[]
    droppedOldest: number
}

function isValidEvent(value: unknown): value is TelemetryEvent {
    if (typeof value !== 'object' || value === null) return false
    const ev = value as Partial<TelemetryEvent>
    return typeof ev.id === 'string' && typeof ev.seq === 'number' && typeof ev.ts === 'number'
}

export function readOutbox(): { events: TelemetryEvent[]; droppedOldest: number } {
    try {
        const raw = localStorage.getItem(OUTBOX_STORAGE_KEY)
        if (!raw) return { events: [], droppedOldest: 0 }
        const parsed = JSON.parse(raw) as Partial<OutboxFile>
        if (parsed.v !== 1 || !Array.isArray(parsed.events)) return { events: [], droppedOldest: 0 }
        const events = parsed.events.filter(isValidEvent)
        const droppedOldest = typeof parsed.droppedOldest === 'number' ? parsed.droppedOldest : 0
        return { events, droppedOldest }
    } catch {
        return { events: [], droppedOldest: 0 }
    }
}

/**
 * Persist events (deduped by id against what is already there), trimming the
 * oldest until the serialized file fits OUTBOX_MAX_BYTES. Never throws.
 */
export function appendOutbox(events: readonly TelemetryEvent[]): void {
    try {
        const current = readOutbox()
        const byId = new Map<string, TelemetryEvent>()
        for (const ev of current.events) byId.set(ev.id, ev)
        for (const ev of events) {
            if (isValidEvent(ev)) byId.set(ev.id, ev)
        }
        let kept = [...byId.values()].sort((a, b) => a.seq - b.seq)
        let dropped = current.droppedOldest
        while (kept.length > 0) {
            const serialized = JSON.stringify({ v: 1, events: kept, droppedOldest: dropped } satisfies OutboxFile)
            if (serialized.length <= OUTBOX_MAX_BYTES) {
                localStorage.setItem(OUTBOX_STORAGE_KEY, serialized)
                return
            }
            kept = kept.slice(1)
            dropped += 1
        }
        // Even an empty file does not fit (should be impossible) — clear.
        localStorage.removeItem(OUTBOX_STORAGE_KEY)
    } catch {
        // fail-silent
    }
}

/** Remove delivered events from the outbox by id. Never throws. */
export function removeFromOutbox(ids: readonly string[]): void {
    try {
        if (ids.length === 0) return
        const idSet = new Set(ids)
        const current = readOutbox()
        const kept = current.events.filter((ev) => !idSet.has(ev.id))
        if (kept.length === current.events.length) return
        if (kept.length === 0) {
            localStorage.removeItem(OUTBOX_STORAGE_KEY)
            return
        }
        localStorage.setItem(OUTBOX_STORAGE_KEY, JSON.stringify({ v: 1, events: kept, droppedOldest: current.droppedOldest } satisfies OutboxFile))
    } catch {
        // fail-silent
    }
}

export function outboxEventCount(): number {
    try {
        return readOutbox().events.length
    } catch {
        return 0
    }
}
