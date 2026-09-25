import type {
    UsageQueryAgent,
    UsageQueryAdapter,
    UsageQueryResult,
    UsageQueryTemplate,
    UsageQueryWindow,
    UsageQueryWindowSpec
} from '@hapi/protocol/usageQuery'
import {
    USAGE_QUERY_MAX_RESPONSE_BYTES,
    USAGE_QUERY_TIMEOUT_MS
} from '@hapi/protocol/usageQuery'
import type { ResolvedUsageCredentials } from './credentials'

type FetchResponseLike = {
    ok: boolean
    status: number
    headers?: { get(name: string): string | null }
    body?: { getReader(): ReadableStreamDefaultReader<Uint8Array> }
    text(): Promise<string>
}

export type UsageQueryFetch = (
    input: string,
    init: {
        method: string
        headers: Record<string, string>
        signal: AbortSignal
        redirect: 'error'
    }
) => Promise<FetchResponseLike>

export class UsageQueryExecutionError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'UsageQueryExecutionError'
    }
}

function parseNumber(value: unknown): number | null {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null
    if (typeof value !== 'string') return null
    const trimmed = value.trim()
    if (!trimmed) return null
    const number = Number(trimmed)
    return Number.isFinite(number) ? number : null
}

function isLoopbackHostname(hostname: string): boolean {
    const normalized = hostname.toLowerCase()
    return normalized === 'localhost'
        || normalized === '127.0.0.1'
        || normalized === '[::1]'
        || normalized === '::1'
}

function normalizeBaseUrl(value: string): URL {
    let parsed: URL
    try {
        parsed = new URL(value)
    } catch {
        throw new UsageQueryExecutionError('Base URL is invalid')
    }
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopbackHostname(parsed.hostname))) {
        throw new UsageQueryExecutionError('Base URL must use HTTPS (loopback HTTP is allowed)')
    }
    if (parsed.username || parsed.password) {
        throw new UsageQueryExecutionError('Base URL must not contain embedded credentials')
    }
    parsed.hash = ''
    parsed.search = ''
    parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/'
    return parsed
}

function substitute(value: string, credentials: ResolvedUsageCredentials, baseOrigin: string): string {
    return value
        .replaceAll('{{baseUrl}}', credentials.baseUrl.replace(/\/+$/, ''))
        .replaceAll('{{baseOrigin}}', baseOrigin)
        .replaceAll('{{apiKey}}', credentials.apiKey)
}

function resolveRequestUrl(rawUrl: string, credentials: ResolvedUsageCredentials, baseOrigin: string): URL {
    if (rawUrl.includes('{{apiKey}}') || (credentials.apiKey && rawUrl.includes(credentials.apiKey))) {
        throw new UsageQueryExecutionError('API key cannot appear in the request URL')
    }
    const baseUrl = normalizeBaseUrl(credentials.baseUrl)
    const substituted = substitute(rawUrl, credentials, baseOrigin)
    let requestUrl: URL
    try {
        requestUrl = new URL(substituted, baseUrl)
    } catch {
        throw new UsageQueryExecutionError('Request URL is invalid')
    }
    if (requestUrl.origin !== baseUrl.origin) {
        throw new UsageQueryExecutionError('Request URL must use the configured base URL origin')
    }
    if (requestUrl.username || requestUrl.password) {
        throw new UsageQueryExecutionError('Request URL must not contain embedded credentials')
    }
    if (requestUrl.protocol !== 'https:' && !(requestUrl.protocol === 'http:' && isLoopbackHostname(requestUrl.hostname))) {
        throw new UsageQueryExecutionError('Request URL must use HTTPS (loopback HTTP is allowed)')
    }
    return requestUrl
}

function tokenizePath(path: string): string[] | null {
    const tokens: string[] = []
    let cursor = 0
    while (cursor < path.length) {
        if (path[cursor] === '.') {
            cursor += 1
            continue
        }
        if (path[cursor] === '[') {
            const end = path.indexOf(']', cursor + 1)
            if (end < 0 || !/^\d+$/.test(path.slice(cursor + 1, end))) return null
            tokens.push(path.slice(cursor + 1, end))
            cursor = end + 1
            continue
        }
        const start = cursor
        while (cursor < path.length && path[cursor] !== '.' && path[cursor] !== '[') cursor += 1
        if (start === cursor) return null
        tokens.push(path.slice(start, cursor))
    }
    return tokens.length > 0 ? tokens : null
}

/** Resolve the small dot/bracket path syntax used by the safe templates. */
export function getUsageJsonPath(value: unknown, path: string | undefined): unknown {
    if (!path) return undefined
    const tokens = tokenizePath(path.trim())
    if (!tokens) return undefined
    let current: unknown = value
    for (const token of tokens) {
        if (current === null || current === undefined || typeof current !== 'object') return undefined
        if (Array.isArray(current)) {
            const index = Number(token)
            if (!Number.isSafeInteger(index) || index < 0 || index >= current.length) return undefined
            current = current[index]
        } else {
            current = (current as Record<string, unknown>)[token]
        }
    }
    return current
}

export function parseResetTimestamp(value: unknown, unit: UsageQueryWindowSpec['resetUnit']): number | null {
    if (unit === 'seconds' || unit === 'milliseconds') {
        const number = parseNumber(value)
        if (number === null || number <= 0) return null
        return unit === 'milliseconds' ? Math.round(number) : Math.round(number * 1000)
    }
    if (typeof value === 'string') {
        const timestamp = Date.parse(value)
        return Number.isFinite(timestamp) ? timestamp : null
    }
    const number = parseNumber(value)
    if (number === null || number <= 0) return null
    if (number >= 1_000_000_000_000) return Math.round(number)
    return Math.round(number * 1000)
}

function clampPercent(value: number): number {
    return Math.min(100, Math.max(0, Math.round(value)))
}

async function readBoundedResponseText(response: FetchResponseLike): Promise<string> {
    const reader = response.body?.getReader()
    if (!reader) {
        // Test doubles and non-streaming fetch implementations may only expose
        // text(). Production Fetch Responses provide a body stream, so the
        // bounded path is used for real requests.
        const raw = await response.text()
        if (new TextEncoder().encode(raw).byteLength > USAGE_QUERY_MAX_RESPONSE_BYTES) {
            throw new UsageQueryExecutionError('Usage response is too large')
        }
        return raw
    }

    const chunks: Uint8Array[] = []
    let totalBytes = 0
    try {
        while (true) {
            const next = await reader.read()
            if (next.done) break
            if (!next.value) continue
            totalBytes += next.value.byteLength
            if (totalBytes > USAGE_QUERY_MAX_RESPONSE_BYTES) {
                await reader.cancel()
                throw new UsageQueryExecutionError('Usage response is too large')
            }
            chunks.push(next.value)
        }
    } finally {
        reader.releaseLock()
    }

    const bytes = new Uint8Array(totalBytes)
    let offset = 0
    for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
    }
    return new TextDecoder().decode(bytes)
}

/** Convert one response window into the normalized Hapi shape. */
export function normalizeUsageWindow(body: unknown, spec: UsageQueryWindowSpec): UsageQueryWindow | null {
    let percent: number | null = null
    const direct = parseNumber(getUsageJsonPath(body, spec.percentPath))
    if (direct !== null) {
        percent = (spec.percentScale ?? 'percent') === 'ratio' ? direct * 100 : direct
    }

    const limit = parseNumber(getUsageJsonPath(body, spec.limitPath))
    if (percent === null && limit !== null && limit > 0) {
        const used = parseNumber(getUsageJsonPath(body, spec.usedPath))
        const remaining = parseNumber(getUsageJsonPath(body, spec.remainingPath))
        if (used !== null) percent = (used / limit) * 100
        else if (remaining !== null) percent = ((limit - remaining) / limit) * 100
    }
    if (percent === null) return null

    return {
        usedPercent: clampPercent(percent),
        resetsAt: parseResetTimestamp(getUsageJsonPath(body, spec.resetPath), spec.resetUnit)
    }
}

function emptyUsageWindows(): { fiveHour: UsageQueryWindow | null; sevenDay: UsageQueryWindow | null } {
    return { fiveHour: null, sevenDay: null }
}

function normalizeKimiWindows(body: unknown): { fiveHour: UsageQueryWindow | null; sevenDay: UsageQueryWindow | null } {
    return {
        fiveHour: normalizeUsageWindow(body, {
            remainingPath: 'limits[0].detail.remaining',
            limitPath: 'limits[0].detail.limit',
            resetPath: 'limits[0].detail.resetTime',
            resetUnit: 'iso'
        }),
        sevenDay: normalizeUsageWindow(body, {
            remainingPath: 'usage.remaining',
            limitPath: 'usage.limit',
            resetPath: 'usage.resetTime',
            resetUnit: 'iso'
        })
    }
}

function normalizeZenMuxWindows(body: unknown): { fiveHour: UsageQueryWindow | null; sevenDay: UsageQueryWindow | null } {
    return {
        fiveHour: normalizeUsageWindow(body, {
            percentPath: 'data.quota_5_hour.usage_percentage',
            percentScale: 'ratio',
            resetPath: 'data.quota_5_hour.resets_at',
            resetUnit: 'iso'
        }),
        sevenDay: normalizeUsageWindow(body, {
            percentPath: 'data.quota_7_day.usage_percentage',
            percentScale: 'ratio',
            resetPath: 'data.quota_7_day.resets_at',
            resetUnit: 'iso'
        })
    }
}

function normalizeZhipuWindows(body: unknown): { fiveHour: UsageQueryWindow | null; sevenDay: UsageQueryWindow | null } {
    const limits = getUsageJsonPath(body, 'data.limits')
    if (!Array.isArray(limits)) return emptyUsageWindows()
    const candidates = limits.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
        .filter((item) => {
            const type = String(item.type ?? '').toLowerCase()
            return type === 'tokens_limit' || type === 'credit_limit'
        })
        .map((item) => ({
            item,
            window: normalizeUsageWindow(item, {
                percentPath: 'percentage',
                percentScale: 'percent',
                resetPath: 'nextResetTime',
                resetUnit: 'milliseconds'
            }),
            unit: Number(item.unit)
        }))
        .filter((candidate): candidate is { item: Record<string, unknown>; window: UsageQueryWindow; unit: number } => candidate.window !== null)

    let fiveHour = candidates.find((candidate) => candidate.unit === 3)?.window ?? null
    let sevenDay = candidates.find((candidate) => candidate.unit === 6)?.window ?? null
    const remaining = candidates.filter((candidate) => candidate.window !== fiveHour && candidate.window !== sevenDay)
        .sort((left, right) => Number(left.window.resetsAt !== null) - Number(right.window.resetsAt !== null)
            || (left.window.resetsAt ?? Number.MIN_SAFE_INTEGER) - (right.window.resetsAt ?? Number.MIN_SAFE_INTEGER))
    if (!fiveHour) fiveHour = remaining.shift()?.window ?? null
    if (!sevenDay) sevenDay = remaining.shift()?.window ?? null
    return { fiveHour, sevenDay }
}

function normalizeMiniMaxWindows(body: unknown): { fiveHour: UsageQueryWindow | null; sevenDay: UsageQueryWindow | null } {
    const remains = getUsageJsonPath(body, 'model_remains')
    if (!Array.isArray(remains)) return emptyUsageWindows()
    const general = remains.find((item) => item && typeof item === 'object' && (item as Record<string, unknown>).model_name === 'general')
    if (!general || typeof general !== 'object') return emptyUsageWindows()
    const item = general as Record<string, unknown>
    const fiveRemaining = parseNumber(item.current_interval_remaining_percent)
    const fiveHour = fiveRemaining === null ? null : {
        usedPercent: clampPercent(100 - fiveRemaining),
        resetsAt: parseResetTimestamp(item.end_time, 'milliseconds')
    }
    const weeklyStatus = parseNumber(item.current_weekly_status)
    const weeklyRemaining = parseNumber(item.current_weekly_remaining_percent)
    const sevenDay = weeklyStatus === 1 && weeklyRemaining !== null ? {
        usedPercent: clampPercent(100 - weeklyRemaining),
        resetsAt: parseResetTimestamp(item.weekly_end_time, 'milliseconds')
    } : null
    return { fiveHour, sevenDay }
}

function normalizeAdapterWindows(
    body: unknown,
    adapter: UsageQueryAdapter,
    template: UsageQueryTemplate
): { fiveHour: UsageQueryWindow | null; sevenDay: UsageQueryWindow | null } {
    switch (adapter) {
        case 'kimi-coding': return normalizeKimiWindows(body)
        case 'zenmux-subscription': return normalizeZenMuxWindows(body)
        case 'zhipu-coding': return normalizeZhipuWindows(body)
        case 'minimax-coding': return normalizeMiniMaxWindows(body)
        case 'json-path':
        default:
            return {
                fiveHour: normalizeUsageWindow(body, template.fiveHour),
                sevenDay: normalizeUsageWindow(body, template.sevenDay)
            }
    }
}

function createAbortSignal(signal: AbortSignal | undefined, timeoutMs: number): {
    signal: AbortSignal
    dispose: () => void
} {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    return {
        signal: controller.signal,
        dispose: () => {
            clearTimeout(timeout)
            signal?.removeEventListener('abort', abort)
            controller.abort()
        }
    }
}

export async function executeUsageQueryTemplate(
    agent: UsageQueryAgent,
    template: UsageQueryTemplate,
    credentials: ResolvedUsageCredentials,
    options: {
        fetchImpl?: UsageQueryFetch
        timeoutMs?: number
        now?: number
    } = {}
): Promise<UsageQueryResult> {
    if (!credentials.baseUrl) throw new UsageQueryExecutionError('Base URL is not configured')
    if (!credentials.apiKey) throw new UsageQueryExecutionError('API key is not configured')

    const fetchImpl = options.fetchImpl ?? (fetch as unknown as UsageQueryFetch)
    const normalizedBase = normalizeBaseUrl(credentials.baseUrl)
    const normalizedCredentials: ResolvedUsageCredentials = {
        ...credentials,
        baseUrl: normalizedBase.toString().replace(/\/+$/, '')
    }
    const requestUrl = resolveRequestUrl(template.request.url, normalizedCredentials, normalizedBase.origin)
    const headers = Object.fromEntries(
        Object.entries(template.request.headers).map(([name, value]) => [name, substitute(value, normalizedCredentials, normalizedBase.origin)])
    )
    const { signal, dispose } = createAbortSignal(undefined, options.timeoutMs ?? USAGE_QUERY_TIMEOUT_MS)
    let response: FetchResponseLike
    try {
        response = await fetchImpl(requestUrl.toString(), {
            method: template.request.method,
            headers,
            redirect: 'error',
            signal
        })
    } catch (error) {
        const timedOut = signal.aborted
        dispose()
        if (timedOut) throw new UsageQueryExecutionError('Usage request timed out')
        throw new UsageQueryExecutionError(error instanceof Error ? error.message : 'Usage request failed')
    }

    try {
        if (!response.ok) throw new UsageQueryExecutionError(`Usage request failed (HTTP ${response.status})`)
        const length = response.headers?.get('content-length')
        if (length && Number(length) > USAGE_QUERY_MAX_RESPONSE_BYTES) {
            throw new UsageQueryExecutionError('Usage response is too large')
        }

        const raw = await readBoundedResponseText(response)

        let body: unknown
        try {
            body = JSON.parse(raw) as unknown
        } catch {
            throw new UsageQueryExecutionError('Usage response was not valid JSON')
        }

        const { fiveHour, sevenDay } = normalizeAdapterWindows(body, template.adapter, template)
        if (!fiveHour && !sevenDay) throw new UsageQueryExecutionError('Usage response contained no configured quota windows')

        return {
            agent,
            templateId: template.id,
            status: 'success',
            fiveHour,
            sevenDay,
            queriedAt: options.now ?? Date.now(),
            stale: false
        }
    } finally {
        dispose()
    }
}
