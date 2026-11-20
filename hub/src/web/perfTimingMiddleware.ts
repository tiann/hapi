import type { MiddlewareHandler } from 'hono'
import {
    normalizeApiPath,
    TELEMETRY_SELF_HEADER,
    TELEMETRY_TRACE_HEADER
} from '@hapi/protocol/telemetry'
import type { HubPerfSampleInput } from '../store/telemetry'
import type { WebAppEnv } from './middleware/auth'

/**
 * Hub-plane perf timing middleware (research report §4.2 "http(hub 行)").
 *
 * Mount outermost (before the logger) so the sample spans auth, handlers and
 * compression. Records one perf_samples row per /api/* or /cli/* request:
 * total_ms is time-to-response-start (handler + middleware; streaming bodies
 * are not awaited — hub plane measures the server leg, the web plane's own
 * rows carry the network leg). Skip rules (ruling §3.4 #11):
 * /health, /socket.io/*, static assets (only /api and /cli planes record),
 * /api/telemetry/* (self-excitation) and any request bearing the SDK
 * self-header. The trace header is echoed on every response that carried it
 * so the web SDK can pair its fetch row with ours. Fail-silent by contract:
 * telemetry must never break or slow a request.
 */

export function isHubPerfRecordablePath(path: string): boolean {
    if (path === '/health' || path.startsWith('/health/')) return false
    if (path === '/socket.io' || path.startsWith('/socket.io/')) return false
    if (path === '/api/telemetry' || path.startsWith('/api/telemetry/')) return false
    if (path === '/api' || path.startsWith('/api/')) return true
    if (path === '/cli' || path.startsWith('/cli/')) return true
    return false
}

function contentLengthToBytes(raw: string | null | undefined): number | undefined {
    if (!raw) return undefined
    const n = Number(raw)
    return Number.isFinite(n) && n >= 0 ? n : undefined
}

export function createPerfTimingMiddleware(
    record: (sample: HubPerfSampleInput) => void
): MiddlewareHandler<WebAppEnv> {
    return async (c, next) => {
        const startedTs = Date.now()
        const startedAt = performance.now()
        try {
            await next()
        } finally {
            // Runs on both success and handler-throw paths; rethrow happens
            // after this block so the failure leg still gets its sample
            // (status 0 = no response produced).
            try {
                const traceId = c.req.header(TELEMETRY_TRACE_HEADER)
                if (traceId) {
                    const echoed = traceId.slice(0, 64)
                    try {
                        c.res?.headers.set(TELEMETRY_TRACE_HEADER, echoed)
                    } catch {
                        // Immutable response headers — the echo is best-effort.
                    }
                }
                const path = c.req.path
                // OPTIONS is the CORS preflight, not a business request —
                // recording it would pollute the perf statistics (review
                // finding #5). The trace echo above stays unconditional.
                if (
                    c.req.method !== 'OPTIONS'
                    && !c.req.header(TELEMETRY_SELF_HEADER)
                    && isHubPerfRecordablePath(path)
                ) {
                    record({
                        ts: startedTs,
                        method: c.req.method,
                        path,
                        status: c.res?.status ?? 0,
                        totalMs: performance.now() - startedAt,
                        traceId: traceId ? traceId.slice(0, 64) : undefined,
                        reqBytes: contentLengthToBytes(c.req.header('content-length')),
                        resBytes: contentLengthToBytes(c.res?.headers.get('content-length')),
                        namespace: path === '/cli' || path.startsWith('/cli/')
                            ? 'cli'
                            : (c.get('namespace') || 'web')
                    })
                }
            } catch {
                // Fail-silent: telemetry must never affect the request.
            }
        }
    }
}

/** Shared with tests: normalize a raw request path to the stored path_tpl. */
export function hubPerfPathTpl(method: string, path: string): string {
    return normalizeApiPath(method, path)
}
