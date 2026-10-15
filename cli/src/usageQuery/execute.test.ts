import { describe, expect, it } from 'vitest'
import {
    DEFAULT_USAGE_QUERY_TEMPLATE,
    DEFAULT_USAGE_QUERY_TEMPLATES,
    USAGE_QUERY_MAX_RESPONSE_BYTES,
    UsageQueryTemplateSchema,
    type UsageQueryTemplate
} from '@hapi/protocol/usageQuery'
import {
    executeUsageQueryTemplate,
    getUsageJsonPath,
    normalizeUsageWindow,
    parseResetTimestamp,
    type UsageQueryFetch
} from './execute'
import type { ResolvedUsageCredentials } from './credentials'

const credentials: ResolvedUsageCredentials = {
    baseUrl: 'https://provider.example/api',
    apiKey: 'secret-value',
    baseUrlSource: 'config',
    apiKeySource: 'config'
}

function response(body: unknown, init: { ok?: boolean; status?: number; contentLength?: string } = {}) {
    return {
        ok: init.ok ?? true,
        status: init.status ?? 200,
        headers: { get: (name: string) => name.toLowerCase() === 'content-length' ? (init.contentLength ?? null) : null },
        text: async () => JSON.stringify(body)
    }
}

function makeTemplate(overrides: Partial<UsageQueryTemplate> = {}): UsageQueryTemplate {
    return UsageQueryTemplateSchema.parse({
        ...DEFAULT_USAGE_QUERY_TEMPLATE,
        ...overrides
    })
}

describe('usage query executor', () => {
    it('resolves the restricted dot and numeric bracket path syntax', () => {
        const body = { limits: [{ detail: { remaining: '24' } }] }
        expect(getUsageJsonPath(body, 'limits[0].detail.remaining')).toBe('24')
        expect(getUsageJsonPath(body, 'limits[1].detail.remaining')).toBeUndefined()
        expect(getUsageJsonPath(body, 'limits[0].detail[0]')).toBeUndefined()
        expect(getUsageJsonPath(body, 'limits[0].detail.remaining; evil')).toBeUndefined()
    })

    it('normalizes the built-in Kimi-style remaining/limit windows', async () => {
        const template = DEFAULT_USAGE_QUERY_TEMPLATES.find((item) => item.id === 'kimi-coding-plan')!
        const reset = '2026-09-07T00:00:00.000Z'
        const fetchImpl: UsageQueryFetch = async (url, init) => {
            expect(url).toBe('https://provider.example/coding/v1/usages')
            expect(init.method).toBe('GET')
            expect(init.headers.Authorization).toBe('Bearer secret-value')
            return response({
                limits: [{ detail: { remaining: 25, limit: 100, resetTime: reset } }],
                usage: { remaining: 900, limit: 1000, resetTime: reset }
            })
        }

        const result = await executeUsageQueryTemplate('claude', template, credentials, { fetchImpl, now: 123 })
        expect(result).toMatchObject({
            agent: 'claude',
            templateId: template.id,
            status: 'success',
            fiveHour: { usedPercent: 75, resetsAt: Date.parse(reset) },
            sevenDay: { usedPercent: 10, resetsAt: Date.parse(reset) },
            queriedAt: 123,
            stale: false
        })
    })

    it('normalizes a configured base URL before appending the template path', async () => {
        const template = DEFAULT_USAGE_QUERY_TEMPLATES.find((item) => item.id === 'kimi-coding-plan')!
        const fetchImpl: UsageQueryFetch = async (url) => {
            expect(url).toBe('https://provider.example/coding/v1/usages')
            return response({ usage: { remaining: 1, limit: 2 } })
        }
        const result = await executeUsageQueryTemplate('claude', template, {
            ...credentials,
            baseUrl: 'https://provider.example/api/?ignored=query#fragment'
        }, { fetchImpl })
        expect(result.sevenDay?.usedPercent).toBe(50)
    })

    it('supports direct ratio percentages and clamps them to the normalized range', () => {
        const window = normalizeUsageWindow(
            { value: 1.4, reset: 1_780_000_000 },
            { percentPath: 'value', percentScale: 'ratio', resetPath: 'reset', resetUnit: 'seconds' }
        )
        expect(window).toEqual({ usedPercent: 100, resetsAt: 1_780_000_000_000 })
        expect(normalizeUsageWindow(
            { value: 0.4, reset: 1_780_000_000_000 },
            { percentPath: 'value', percentScale: 'ratio', resetPath: 'reset', resetUnit: 'iso' }
        )?.resetsAt).toBe(1_780_000_000_000)
    })

    it('does not coerce blank or non-scalar quota values to numbers', () => {
        const spec = { percentPath: 'value', resetUnit: 'iso' as const }
        expect(normalizeUsageWindow({ value: '  ' }, spec)).toBeNull()
        expect(normalizeUsageWindow({ value: [] }, spec)).toBeNull()
    })

    it('honors explicit units for numeric epoch strings', () => {
        expect(parseResetTimestamp('1780000000', 'seconds')).toBe(1_780_000_000_000)
        expect(parseResetTimestamp('1780000000000', 'milliseconds')).toBe(1_780_000_000_000)
    })

    it('normalizes ZenMux, Zhipu, and MiniMax reviewed adapters', async () => {
        const run = async (adapter: UsageQueryTemplate['adapter'], body: unknown) => {
            const template = UsageQueryTemplateSchema.parse({
                ...DEFAULT_USAGE_QUERY_TEMPLATE,
                id: `adapter-${adapter}`,
                adapter,
                request: { ...DEFAULT_USAGE_QUERY_TEMPLATE.request, url: '{{baseOrigin}}/quota' },
                fiveHour: {},
                sevenDay: {}
            })
            return await executeUsageQueryTemplate('claude', template, credentials, {
                fetchImpl: async () => response(body)
            })
        }

        const zenmux = await run('zenmux-subscription', {
            data: {
                quota_5_hour: { usage_percentage: 0.25, resets_at: '2026-09-10T00:00:00Z' },
                quota_7_day: { usage_percentage: 0.4, resets_at: '2026-09-11T00:00:00Z' }
            }
        })
        expect(zenmux.fiveHour?.usedPercent).toBe(25)
        expect(zenmux.sevenDay?.usedPercent).toBe(40)

        const zhipu = await run('zhipu-coding', {
            data: { limits: [
                { type: 'TOKENS_LIMIT', unit: 6, percentage: 60, nextResetTime: 1_780_100_000_000 },
                { type: 'TOKENS_LIMIT', unit: 3, percentage: 20, nextResetTime: 1_780_050_000_000 }
            ] }
        })
        expect(zhipu.fiveHour?.usedPercent).toBe(20)
        expect(zhipu.sevenDay?.usedPercent).toBe(60)

        const minimax = await run('minimax-coding', {
            model_remains: [{
                model_name: 'general',
                current_interval_remaining_percent: 75,
                end_time: 1_780_050_000_000,
                current_weekly_status: 1,
                current_weekly_remaining_percent: 50,
                weekly_end_time: 1_780_100_000_000
            }]
        })
        expect(minimax.fiveHour?.usedPercent).toBe(25)
        expect(minimax.sevenDay?.usedPercent).toBe(50)
    })

    it('rejects cross-origin URLs and API keys embedded in URLs', async () => {
        const crossOrigin = makeTemplate({ request: { ...DEFAULT_USAGE_QUERY_TEMPLATE.request, url: 'https://other.example/usage' } })
        await expect(executeUsageQueryTemplate('codex', crossOrigin, credentials, { fetchImpl: async () => response({}) }))
            .rejects.toThrow('configured base URL origin')

        const keyInUrl = makeTemplate({ request: { ...DEFAULT_USAGE_QUERY_TEMPLATE.request, url: '{{baseUrl}}/usage?key={{apiKey}}' } })
        await expect(executeUsageQueryTemplate('codex', keyInUrl, credentials, { fetchImpl: async () => response({}) }))
            .rejects.toThrow('API key cannot appear')

        const literalKeyInUrl = makeTemplate({ request: { ...DEFAULT_USAGE_QUERY_TEMPLATE.request, url: 'https://provider.example/usage?key=secret-value' } })
        await expect(executeUsageQueryTemplate('codex', literalKeyInUrl, credentials, { fetchImpl: async () => response({}) }))
            .rejects.toThrow('API key cannot appear')

        const embeddedCredentials = makeTemplate({ request: { ...DEFAULT_USAGE_QUERY_TEMPLATE.request, url: 'https://user:pass@provider.example/usage' } })
        await expect(executeUsageQueryTemplate('codex', embeddedCredentials, credentials, { fetchImpl: async () => response({}) }))
            .rejects.toThrow('embedded credentials')

        const redirectTemplate = DEFAULT_USAGE_QUERY_TEMPLATES.find((item) => item.id === 'kimi-coding-plan')!
        const redirected = executeUsageQueryTemplate('claude', redirectTemplate, credentials, {
            fetchImpl: async (_url, init) => {
                expect(init.redirect).toBe('error')
                return response({}, { ok: false, status: 302 })
            }
        })
        await expect(redirected).rejects.toThrow('HTTP 302')
    })

    it('rejects non-success and oversized responses without exposing the body', async () => {
        const template = makeTemplate()
        await expect(executeUsageQueryTemplate('claude', template, credentials, {
            fetchImpl: async () => response({ secret: 'must-not-be-returned' }, { ok: false, status: 401 })
        })).rejects.toThrow('HTTP 401')
        await expect(executeUsageQueryTemplate('claude', template, credentials, {
            fetchImpl: async () => response({}, { contentLength: String(3 * 1024 * 1024) })
        })).rejects.toThrow('too large')

        const encoder = new TextEncoder()
        const oversizedChunk = encoder.encode(JSON.stringify({ data: 'x'.repeat(USAGE_QUERY_MAX_RESPONSE_BYTES + 1) }))
        const streamTemplate = makeTemplate()
        await expect(executeUsageQueryTemplate('claude', streamTemplate, credentials, {
            fetchImpl: async () => ({
                ok: true,
                status: 200,
                headers: { get: () => null },
                body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(oversizedChunk); controller.close() } }) as unknown as { getReader(): ReadableStreamDefaultReader<Uint8Array> },
                text: async () => ''
            })
        })).rejects.toThrow('too large')
    })

    it('aborts unread responses when rejecting early', async () => {
        let errorSignal: AbortSignal | undefined
        await expect(executeUsageQueryTemplate('claude', makeTemplate(), credentials, {
            fetchImpl: async (_url, init) => {
                errorSignal = init.signal
                return response({}, { ok: false, status: 502 })
            }
        })).rejects.toThrow('HTTP 502')
        expect(errorSignal?.aborted).toBe(true)

        let oversizedSignal: AbortSignal | undefined
        await expect(executeUsageQueryTemplate('claude', makeTemplate(), credentials, {
            fetchImpl: async (_url, init) => {
                oversizedSignal = init.signal
                return response({}, { contentLength: String(USAGE_QUERY_MAX_RESPONSE_BYTES + 1) })
            }
        })).rejects.toThrow('too large')
        expect(oversizedSignal?.aborted).toBe(true)

        let networkSignal: AbortSignal | undefined
        await expect(executeUsageQueryTemplate('claude', makeTemplate(), credentials, {
            fetchImpl: async (_url, init) => {
                networkSignal = init.signal
                throw new Error('network unavailable')
            }
        })).rejects.toThrow('network unavailable')
        expect(networkSignal?.aborted).toBe(true)
    })

    it('aborts a request at the ten-second default timeout boundary', async () => {
        const template = makeTemplate()
        await expect(executeUsageQueryTemplate('claude', template, credentials, {
            timeoutMs: 5,
            fetchImpl: async (_url, init) => await new Promise((_resolve, reject) => {
                init.signal.addEventListener('abort', () => reject(new Error('aborted by timeout')), { once: true })
            })
        })).rejects.toThrow('timed out')
    })
})
