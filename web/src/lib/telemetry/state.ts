import type { TelemetryEvent, TelemetryLevel } from '@hapi/protocol/telemetry'

/**
 * Telemetry SDK shared runtime state (module-level singleton, non-React).
 *
 * Every sub-module (queue / negotiate / uplink / httpObserver / installers)
 * reads and writes this one container so `resetTelemetryState()` (test-only)
 * can restore a pristine machine between vitest cases — the module-level
 * cache leak lesson from the voice-providers TTL work applies here too.
 *
 * All mutating helpers are fail-silent by contract: a telemetry bug must
 * never surface as an app bug (design §7.2 risk 2).
 */

export interface TelemetryRuntimeConfig {
    getAuthToken: () => string | null
    baseUrl: string
}

/** capture() options — the pinned public TelemetryCaptureOpts (index.ts re-exports). */
export interface TelemetryCaptureOpts {
    sessionId?: string
    severity?: 'error' | 'warn' | 'info'
    fingerprint?: string
}

/** Memory queue entry: the event plus its serialized size (bytes bookkeeping). */
export interface QueuedEvent {
    ev: TelemetryEvent
    bytes: number
}

/** Registered in-flight http observation (drained at pagehide). */
export interface PendingHttpObservation {
    finish: () => void
}

// --- queue / flush constants (design §3.1) ---------------------------------

/** Memory queue hard cap; overflow drops the oldest events and counts them. */
export const MAX_QUEUE_EVENTS = 500
/** Flush when the queue holds at least this many events. */
export const FLUSH_COUNT_THRESHOLD = 32
/** Flush when accumulated serialized events reach this size. */
export const FLUSH_BYTES_THRESHOLD = 24 * 1024
/** Flush when the oldest queued event ages past this (L1). */
export const FLUSH_AGE_MS_L1 = 60_000
/** L2+ is a debugging level: fresher data, 30s (ruling 12). */
export const FLUSH_AGE_MS_L2PLUS = 30_000
/** Stop adding events to a normal batch here (leaves headroom under the
 * 256 KiB endpoint bodyLimit even at the 64-event × 4 KiB worst case). */
export const BATCH_BYTES_CEILING = 200 * 1024
/** pagehide keepalive slice cap (keepalive bodies cap at 64 KiB wire size). */
export const PAGEHIDE_SLICE_BYTES = 48 * 1024
/** localStorage outbox hard cap; overflow drops oldest events (34G lesson). */
export const OUTBOX_MAX_BYTES = 256 * 1024

/** Retry the /api/features capability probe this often (old-hub re-negotiation). */
export const RETRY_PROBE_MS = 30 * 60_000
/** Minimum spacing between capability probes (token-triggered retry guard). */
export const PROBE_THROTTLE_MS = 15_000
/** Refresh the negotiated level at most this often after a successful flush. */
export const LEVEL_REFRESH_MS = 5 * 60_000

/** Exponential flush backoff: 1s → 2s → … capped at 5min (storm damping). */
export const BACKOFF_START_MS = 1_000
export const BACKOFF_MAX_MS = 5 * 60_000

/** If the caller never consumes the response body, still emit the http event. */
export const HTTP_BODY_READ_TIMEOUT_MS = 15_000

export const DEVICE_STORAGE_KEY = 'hapi:telemetry:device:v1'
export const OUTBOX_STORAGE_KEY = 'hapi:telemetry:outbox:v1'

export interface TelemetryState {
    /** installTelemetry() completed; sub-modules may act. */
    installed: boolean
    /** Test-only bypass of the import.meta.env.DEV kill switch. */
    forced: boolean
    config: TelemetryRuntimeConfig | null
    /** Capability bit negotiated via GET /api/features (old hub → false). */
    enabled: boolean
    level: TelemetryLevel
    probedAt: number
    probeInFlight: boolean
    probeTimer: ReturnType<typeof setTimeout> | null
    levelRefreshedAt: number
    queue: QueuedEvent[]
    queueBytes: number
    droppedOldest: number
    seq: number
    flushFailures: number
    retryTimer: ReturnType<typeof setTimeout> | null
    ageTimer: ReturnType<typeof setTimeout> | null
    ageTimerDue: number | undefined
    flushing: boolean
    /** Events of the POST currently in flight (re-added to outbox at pagehide;
     *  hub-side INSERT OR IGNORE makes re-delivery harmless). */
    inFlight: TelemetryEvent[]
    /** Latest Bearer token observed at the authProxy single fetch point. */
    lastSeenBearer: string | null
    trigger: string | null
    deviceId: string | null
    handlersInstalled: boolean
    pendingHttp: Set<PendingHttpObservation>
    /** pagehide handling started: late captures (same event loop) are written
     *  straight to the outbox — the memory queue would never be flushed. */
    unloading: boolean
    /** Cumulative events the hub 200-response reported as rejected (schema) —
     *  reported in batch meta next to flushFailures; never retried. */
    serverRejected: number
    /** Cumulative events the hub 200-response reported dropped by level. */
    serverDroppedByLevel: number
}

function freshState(): TelemetryState {
    return {
        installed: false,
        forced: false,
        config: null,
        enabled: false,
        level: 0,
        probedAt: 0,
        probeInFlight: false,
        probeTimer: null,
        levelRefreshedAt: 0,
        queue: [],
        queueBytes: 0,
        droppedOldest: 0,
        seq: 0,
        flushFailures: 0,
        retryTimer: null,
        ageTimer: null,
        ageTimerDue: undefined,
        flushing: false,
        inFlight: [],
        lastSeenBearer: null,
        trigger: null,
        deviceId: null,
        handlersInstalled: false,
        pendingHttp: new Set(),
        unloading: false,
        serverRejected: 0,
        serverDroppedByLevel: 0,
    }
}

export const state: TelemetryState = freshState()

/**
 * Test-only: restore the pristine singleton (clears timers via the same
 * uninstall path installers use; callers in tests must still remove the
 * global listeners — uninstallTelemetry() does that, this is the raw reset).
 */
export function resetTelemetryState(): void {
    const keep = state.forced
    for (const key of Object.keys(state) as Array<keyof TelemetryState>) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (state as any)[key] = (freshState() as any)[key]
    }
    state.forced = keep
}
