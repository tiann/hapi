import type { TelemetryBatch } from '@hapi/protocol/telemetry'
import { installTelemetry, uninstallTelemetry } from './index'
import { state } from './state'

/**
 * Test-only kit for the telemetry SDK (never imported by app code).
 *
 * `resetTelemetryForTest` restores the pristine module machine between vitest
 * cases (module-level state would otherwise leak across tests — the
 * voice-providers TTL lesson); `forceEnableTelemetryForTest` bypasses the
 * import.meta.env.DEV kill switch (vitest runs with DEV=true).
 *
 * `stubTelemetryFetch` replaces global fetch with a URL router that speaks
 * the two endpoints the SDK touches: GET /api/features (capability+level) and
 * POST /api/telemetry/events (records batches; behavior configurable).
 */

export function forceEnableTelemetryForTest(): void {
    state.forced = true
}

export function resetTelemetryForTest(): void {
    uninstallTelemetry()
    state.forced = false
    try {
        localStorage.removeItem('hapi:telemetry:outbox:v1')
        localStorage.removeItem('hapi:telemetry:device:v1')
    } catch {
        // storage unavailable
    }
}

/** Machine reset WITHOUT touching localStorage — simulates a page reload
 *  (outbox + device identity persist across reloads). */
export function resetTelemetryMachineForTest(): void {
    uninstallTelemetry()
    state.forced = false
}

export interface TelemetryFetchKit {
    /** Batches POSTed to /api/telemetry/events (one entry per request). */
    batches: TelemetryBatch[]
    requests: { url: string; init: RequestInit }[]
    /** Change the negotiated level the features endpoint reports. */
    setLevel: (level: number) => void
    /** Toggle the capability bit off (old hub without telemetry). */
    setCapability: (present: boolean) => void
    /** Make GET /api/features respond with this status (404 = old hub). */
    setFeaturesStatus: (status: number) => void
    /** Make GET /api/features reject (network failure). */
    failFeatures: (mode: 'off' | 'network') => void
    /** Make /api/telemetry/events respond with this status instead of 200. */
    setEventsStatus: (status: number | (() => number)) => void
    /** Counts the hub 200 ingest response reports (accepted/rejected/droppedByLevel). */
    setIngestResult: (result: { accepted?: number; rejected?: number; droppedByLevel?: number }) => void
    /** Make /api/telemetry/events reject (network failure). */
    failEvents: (mode: 'off' | 'network') => void
    restore: () => void
}

export function stubTelemetryFetch(options?: { level?: number; status?: number }): TelemetryFetchKit {
    const originalFetch = globalThis.fetch
    let level = options?.level ?? 1
    let capability = true
    let featuresStatus = 200
    let featuresNetwork: 'off' | 'network' = 'off'
    let eventsStatus: number | (() => number) = options?.status ?? 200
    let networkMode: 'off' | 'network' = 'off'
    let ingest = { accepted: 0, rejected: 0, droppedByLevel: 0 }
    const batches: TelemetryBatch[] = []
    const requests: { url: string; init: RequestInit }[] = []

    const kit: TelemetryFetchKit = {
        batches,
        requests,
        setLevel(next: number) {
            level = next
        },
        setCapability(present: boolean) {
            capability = present
        },
        setFeaturesStatus(status: number) {
            featuresStatus = status
        },
        failFeatures(mode: 'off' | 'network') {
            featuresNetwork = mode
        },
        setEventsStatus(status: number | (() => number)) {
            eventsStatus = status
        },
        setIngestResult(result: { accepted?: number; rejected?: number; droppedByLevel?: number }) {
            ingest = {
                accepted: result.accepted ?? 0,
                rejected: result.rejected ?? 0,
                droppedByLevel: result.droppedByLevel ?? 0,
            }
        },
        failEvents(mode: 'off' | 'network') {
            networkMode = mode
        },
        restore() {
            globalThis.fetch = originalFetch
        },
    }

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        requests.push({ url, init: init ?? {} })
        if (url.includes('/api/features')) {
            if (featuresNetwork === 'network') throw new TypeError('Failed to fetch (test)')
            if (featuresStatus !== 200) return new Response(JSON.stringify({ error: 'test' }), { status: featuresStatus })
            if (!capability) return new Response(JSON.stringify({ githubPrAwareness: { enabled: false, source: 'default' } }), { status: 200 })
            return new Response(JSON.stringify({ telemetry: true, telemetryLevel: level }), { status: 200 })
        }
        if (url.includes('/api/telemetry/events')) {
            if (networkMode === 'network') throw new TypeError('Failed to fetch (test)')
            const status = typeof eventsStatus === 'function' ? eventsStatus() : eventsStatus
            if (status === 200) {
                try {
                    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as TelemetryBatch) : null
                    if (body) batches.push(body)
                } catch {
                    // ignore malformed test bodies
                }
                return new Response(JSON.stringify({ ok: true, ...ingest, level }), { status: 200 })
            }
            return new Response(JSON.stringify({ error: 'test' }), { status })
        }
        // Unrelated traffic passes through to a generic 200 so wrapped callers work.
        return new Response('{}', { status: 200 })
    }) as typeof globalThis.fetch

    return kit
}

/** Convenience: forced-enable + install with the stubbed hub endpoints. */
export function installForTest(kit: TelemetryFetchKit, level: number = 1, baseUrl = 'https://hub.example'): void {
    kit.setLevel(level)
    forceEnableTelemetryForTest()
    installTelemetry({ getAuthToken: () => 'jwt-test-token', baseUrl })
}

/**
 * Await the microtask/macrotask settle needed for probe + flush chains.
 * With fake timers use vi.advanceTimersByTimeAsync instead.
 */
export async function settle(ms = 0): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms))
}
