import { TELEMETRY_SELF_HEADER, TELEMETRY_TRACE_HEADER, normalizeApiPath, sanitizeTelemetryText } from '@hapi/protocol/telemetry'
import { resolveOriginKind, resolveLiveBaseUrl, randomTelemetryId } from './device'
import { onBearerObserved } from './negotiate'
import { captureEvent } from './queue'
import { HTTP_BODY_READ_TIMEOUT_MS, state } from './state'

/**
 * Single-point fetch observation (ruling 8): every request through
 * authProxy's fetchThroughAuthProxy produces EXACTLY ONE perf http row with
 * status/ttfb/total/bytes/traceId/trigger/attempt/phase. ux (trigger 列)与
 * diag(status/phase 列)以列消费,不再各发独立事件。
 *
 * 红线:URL query 由 normalizeApiPath 整串剥弃;错误 code 仅取机器码字段,
 * 绝不采集响应正文;SDK 自身上行带 TELEMETRY_SELF_HEADER 双向豁免(风险 9)。
 */

export type FetchOne = (init: RequestInit | undefined) => Promise<Response>

export async function observeFetchThrough(
    input: string,
    init: RequestInit | undefined,
    doFetch: (init: RequestInit | undefined, fetchOne: FetchOne) => Promise<Response>,
): Promise<Response> {
    const plainFetchOne: FetchOne = (i) => fetch(input, i)
    if (!state.installed) return doFetch(init, plainFetchOne)

    let headerBag: Headers
    try {
        headerBag = new Headers(init?.headers)
    } catch {
        headerBag = new Headers()
    }
    // Self-exemption: never observe (or trace-inject) the SDK's own traffic.
    if (headerBag.get(TELEMETRY_SELF_HEADER)) return doFetch(init, plainFetchOne)

    try {
        noteBearerFromHeaders(headerBag)
    } catch {
        // fail-silent
    }

    const traceId = randomTelemetryId()
    // Trace header injection is gated on the NEGOTIATED state (enabled &&
    // level > 0), not on installation: a new web build pointed at an old hub
    // (custom-hub flow) would otherwise attach a non-safelisted custom header
    // to every request — the preflight rejects it, every fetch throws and the
    // whole app fails to load. Un-negotiated / disabled ⇒ zero extra headers.
    if (state.enabled && state.level > 0) {
        try {
            headerBag.set(TELEMETRY_TRACE_HEADER, traceId)
        } catch {
            // fail-silent — observation continues without the trace key
        }
    }
    const observedInit: RequestInit = init !== undefined ? { ...init, headers: headerBag } : { headers: headerBag }

    const method = typeof init?.method === 'string' && init.method ? init.method.toUpperCase() : 'GET'
    const trigger = state.trigger
    const reqBytes = estimateReqBytes(init?.body)
    const pathTpl = pathTemplateOf(input, method)
    const originKind = resolveOriginKind(resolveLiveBaseUrl(state.config?.baseUrl ?? ''))
    const url = absoluteUrlOf(input)

    let attempts = 0
    const countingFetchOne: FetchOne = (i) => {
        attempts += 1
        return fetch(input, i)
    }
    const t0 = performance.now()
    let res: Response
    try {
        res = await doFetch(observedInit, countingFetchOne)
    } catch (error) {
        try {
            const failedAt = roundMs(performance.now() - t0)
            captureEvent('perf', 'http', {
                method,
                pathTpl,
                status: 0,
                ttfbMs: failedAt,
                totalMs: failedAt,
                ...(reqBytes !== undefined ? { reqBytes } : {}),
                traceId,
                ...(trigger !== null ? { trigger: trigger.slice(0, 32) } : {}),
                ...(attempts > 1 ? { attempt: attempts } : {}),
                phase: 'network',
                ...(originKind ? { originKind } : {}),
            })
        } catch {
            // fail-silent
        }
        throw error
    }
    const ttfbMs = performance.now() - t0
    observeResponseRead(res, { method, pathTpl, ttfbMs, t0, reqBytes, traceId, trigger, originKind, attempts, url })
    return res
}

interface HttpCtx {
    method: string
    pathTpl: string
    ttfbMs: number
    t0: number
    reqBytes?: number
    traceId: string
    trigger: string | null
    originKind?: string
    attempts: number
    url?: string
}

type ReadOutcome = { phase?: 'http' | 'parse'; code?: string } | undefined

function observeResponseRead(res: Response, ctx: HttpCtx): void {
    let settled = false
    let safety: ReturnType<typeof setTimeout> | undefined
    let bodyText: string | undefined
    let bodyReadStarted = false

    const finish = (outcome?: ReadOutcome, totalMsOverride?: number): void => {
        if (settled) return
        settled = true
        if (safety !== undefined) {
            clearTimeout(safety)
            safety = undefined
        }
        try {
            state.pendingHttp.delete(entry)
        } catch {
            // fail-silent
        }
        try {
            const cacheHit = lookupCacheHit(ctx.url, ctx.t0)
            captureEvent('perf', 'http', {
                method: ctx.method,
                pathTpl: ctx.pathTpl,
                status: typeof res.status === 'number' ? res.status : 0,
                ttfbMs: roundMs(ctx.ttfbMs),
                totalMs: totalMsOverride !== undefined ? totalMsOverride : roundMs(performance.now() - ctx.t0),
                ...(ctx.reqBytes !== undefined ? { reqBytes: ctx.reqBytes } : {}),
                ...responseBytes(res),
                ...(cacheHit !== undefined ? { cacheHit } : {}),
                traceId: ctx.traceId,
                ...(ctx.trigger !== null ? { trigger: ctx.trigger.slice(0, 32) } : {}),
                ...(ctx.attempts > 1 ? { attempt: ctx.attempts } : {}),
                ...(outcome?.phase !== undefined ? { phase: outcome.phase } : {}),
                ...(outcome?.code !== undefined ? { code: outcome.code } : {}),
                ...(ctx.originKind ? { originKind: ctx.originKind } : {}),
            })
        } catch {
            // fail-silent
        }
    }
    const entry = { finish }

    // The body is consumed by the caller (client.ts res.json()/res.text()),
    // after this function returns — so totalMs needs a hook on the read.
    // Instance-shadowing the read methods keeps the response identity intact;
    // callers that never read the body fall back to the safety timer.
    for (const name of ['json', 'text', 'arrayBuffer', 'blob', 'formData'] as const) {
        try {
            const original = (res as unknown as Record<string, unknown>)[name]
            if (typeof original !== 'function') continue
            const bound = (original as (...args: unknown[]) => Promise<unknown>).bind(res)
            Object.defineProperty(res, name, {
                configurable: true,
                value: async (...args: unknown[]) => {
                    bodyReadStarted = true
                    try {
                        const value = await bound(...args)
                        if (name === 'text' && typeof value === 'string') bodyText = value
                        finish(res.ok ? undefined : { phase: 'http', code: codeFromBody(res.ok ? undefined : bodyText) })
                        return value
                    } catch (error) {
                        finish(res.ok ? { phase: 'parse' } : { phase: 'http' })
                        throw error
                    }
                },
            })
        } catch {
            // keep the prototype method
        }
    }

    try {
        state.pendingHttp.add(entry)
    } catch {
        // fail-silent
    }
    try {
        safety = setTimeout(() => {
            // The caller never consumed the body (first 401 of a refresh
            // retry, 304 images, …): the request itself finished when the
            // headers arrived — report that moment as totalMs with a
            // body-unread marker instead of polluting p95/p99 with the 15s
            // fallback duration. A read that started but hangs keeps the
            // old fallback (the read genuinely is the request's tail).
            if (!bodyReadStarted) {
                finish({ phase: 'http', code: 'body-unread' }, roundMs(ctx.ttfbMs))
                return
            }
            finish()
        }, HTTP_BODY_READ_TIMEOUT_MS)
    } catch {
        finish()
    }
}

/** Latest Bearer token seen at the single fetch point — the SDK's token
 *  source (JWT lives inside React useAuth state; §main.tsx integration note). */
export function noteBearerFromHeaders(headers: Headers): void {
    try {
        const auth = headers.get('authorization')
        if (!auth) return
        const match = /^Bearer\s+(.+)$/i.exec(auth.trim())
        const token = match?.[1]?.trim()
        if (!token || token === state.lastSeenBearer) return
        state.lastSeenBearer = token
        onBearerObserved()
    } catch {
        // fail-silent
    }
}

// --- field helpers -----------------------------------------------------------

const utf8 = new TextEncoder()

function estimateReqBytes(body: RequestInit['body']): number | undefined {
    try {
        if (body === undefined || body === null) return undefined
        if (typeof body === 'string') return utf8.encode(body).byteLength
        if (body instanceof URLSearchParams) return utf8.encode(body.toString()).byteLength
        if (typeof body === 'object' && 'byteLength' in body && typeof (body as { byteLength?: unknown }).byteLength === 'number') {
            return (body as { byteLength: number }).byteLength
        }
        if (typeof body === 'object' && 'size' in body && typeof (body as { size?: unknown }).size === 'number') {
            return (body as { size: number }).size
        }
    } catch {
        // fail-silent
    }
    return undefined // FormData and streams: not cheaply measurable at P0
}

function responseBytes(res: Response): { resBytes?: number; resBytesSource?: 'content-length' } {
    try {
        const header = res.headers?.get?.('content-length')
        if (!header) return {}
        const parsed = Number.parseInt(header, 10)
        if (Number.isFinite(parsed) && parsed >= 0) return { resBytes: parsed, resBytesSource: 'content-length' }
    } catch {
        // fail-silent
    }
    return {}
}

function lookupCacheHit(url: string | undefined, t0: number): boolean | undefined {
    if (!url) return undefined
    try {
        const entries = performance.getEntriesByName(url, 'resource') as PerformanceResourceTiming[]
        for (let i = entries.length - 1; i >= 0; i--) {
            const entry = entries[i]
            if (entry && entry.startTime >= t0 - 5) {
                if (entry.transferSize === 0 && entry.decodedBodySize > 0) return true
                if (entry.transferSize > 0) return false
                return undefined
            }
        }
    } catch {
        // fail-silent
    }
    return undefined
}

function codeFromBody(bodyText: string | undefined): string | undefined {
    if (!bodyText) return undefined
    try {
        const parsed = JSON.parse(bodyText) as { code?: unknown; error?: unknown }
        const code = typeof parsed.code === 'string' && parsed.code ? parsed.code : (typeof parsed.error === 'string' ? parsed.error : undefined)
        if (!code) return undefined
        return sanitizeTelemetryText(code, 64) || undefined
    } catch {
        return undefined
    }
}

function absoluteUrlOf(input: string): string | undefined {
    try {
        return new URL(input, window.location.href).toString()
    } catch {
        return undefined
    }
}

function pathTemplateOf(input: string, method: string): string {
    try {
        const pathname = new URL(input, window.location.href).pathname
        return normalizeApiPath(method, pathname)
    } catch {
        return normalizeApiPath(method, String(input).split('?')[0] ?? '')
    }
}

function roundMs(ms: number): number {
    const rounded = Math.round(ms)
    return rounded > 0 ? rounded : 0
}
