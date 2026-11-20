/**
 * Telemetry singleton facade for the web capture slice (P0).
 *
 * The real SDK singleton lives in `web/src/lib/telemetry` and is implemented
 * on a parallel branch (feat/telemetry-web-sdk) against a pinned API:
 *
 *   telemetry.capture(domain: 'ux'|'diag'|'perf', kind: string,
 *                      data: Record<string, unknown>,
 *                      opts?: { sessionId?, severity?, fingerprint? }): void
 *   telemetry.setTrigger(trigger: string | null): void
 *
 * This branch runs standalone, so the SDK module does not exist here yet. The
 * facade resolves it with `import.meta.glob` (exact-path patterns that simply
 * match nothing while the module is absent), which means the merge needs NO
 * manual rewiring: as soon as `src/lib/telemetry/index.ts` (or `.ts`) lands,
 * the glob eagerly imports it and every capture flows to the real singleton.
 * Until then — and everywhere capture could throw — every call is a
 * fail-silent no-op: instrumentation must never break the feature it watches.
 */

export type TelemetryDomain = 'ux' | 'diag' | 'perf'
export type TelemetrySeverity = 'error' | 'warn' | 'info'

export interface TelemetryCaptureOptions {
    sessionId?: string
    severity?: TelemetrySeverity
    fingerprint?: string
}

export interface TelemetryApi {
    capture(domain: TelemetryDomain, kind: string, data: Record<string, unknown>, opts?: TelemetryCaptureOptions): void
    setTrigger(trigger: string | null): void
    /** Read-only current negotiated level (0 = off / not installed). Optional
     *  so existing bound stubs stay valid; the facade defaults to 0. */
    getLevel?(): 0 | 1 | 2 | 3
}

/** Optional explicit override (highest precedence); used by tests and by any
 * future boot-time wiring that prefers direct injection over the glob. */
let bound: TelemetryApi | null = null

// Exact-path globs: `{}` while the SDK module is absent, the eagerly imported
// module once it exists. Both the directory (`telemetry/index.ts`) and
// single-file (`telemetry.ts`) shapes are covered so the facade does not
// depend on the SDK branch's internal layout.
const sdkModules = import.meta.glob<{ telemetry?: unknown }>(
    ['/src/lib/telemetry/index.ts', '/src/lib/telemetry.ts'],
    { eager: true },
)

function isTelemetryApi(value: unknown): value is TelemetryApi {
    if (!value || typeof value !== 'object') return false
    const candidate = value as { capture?: unknown; setTrigger?: unknown }
    return typeof candidate.capture === 'function' && typeof candidate.setTrigger === 'function'
}

function resolveSdk(): TelemetryApi | null {
    if (bound) return bound
    try {
        for (const mod of Object.values(sdkModules)) {
            const candidate = (mod as { telemetry?: unknown } | undefined)?.telemetry
            if (isTelemetryApi(candidate)) return candidate
        }
    } catch {
        // glob machinery unavailable in an exotic environment — no-op stays.
    }
    return null
}

/** Bind (or clear) an explicit telemetry implementation. Tests use this or
 * vi.mock the module wholesale. */
export function bindTelemetryClient(api: TelemetryApi | null): void {
    bound = api
}

/** The facade's concrete shape: capture/setTrigger per TelemetryApi plus a
 *  required read-only getLevel (the SDK singleton always provides it; bound
 *  test stubs may omit it — the facade defaults to 0). */
export type TelemetryClient = TelemetryApi & { getLevel(): 0 | 1 | 2 | 3 }

export const telemetryClient: TelemetryClient = {
    capture(domain, kind, data, opts) {
        try {
            resolveSdk()?.capture(domain, kind, data, opts)
        } catch {
            // Instrumentation must never break the feature it watches.
        }
    },
    setTrigger(trigger) {
        try {
            resolveSdk()?.setTrigger(trigger)
        } catch {
            // fail-silent
        }
    },
    getLevel() {
        try {
            const level = resolveSdk()?.getLevel?.()
            return typeof level === 'number' && level >= 0 ? level : 0
        } catch {
            return 0
        }
    },
}
