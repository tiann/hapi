import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
    DEFAULT_USAGE_QUERY_TEMPLATES,
    type UsageQueryTemplate
} from '@hapi/protocol/usageQuery'
import type { ResolvedUsageCredentials } from './credentials'
import { UsageQueryService } from './service'
import type { UsageQueryFetch } from './execute'

const credentials: ResolvedUsageCredentials = {
    baseUrl: 'https://provider.example',
    apiKey: 'test-key',
    baseUrlSource: 'config',
    apiKeySource: 'config'
}

function makeResponse(remaining: number) {
    return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({
            limits: [{ detail: { remaining, limit: 100, resetTime: '2026-09-07T00:00:00.000Z' } }],
            usage: { remaining: 800, limit: 1000, resetTime: '2026-09-08T00:00:00.000Z' }
        })
    }
}

describe('UsageQueryService', () => {
    let root: string | undefined

    afterEach(async () => {
        if (root) await rm(root, { recursive: true, force: true })
        root = undefined
    })

    it('persists settings and caches successful queries for five minutes', async () => {
        root = await mkdtemp(join(tmpdir(), 'hapi-usage-service-'))
        let now = 1_780_000_000_000
        let calls = 0
        const fetchImpl: UsageQueryFetch = async () => {
            calls += 1
            return makeResponse(25)
        }
        const service = new UsageQueryService({
            settingsFile: join(root, 'usage-query.json'),
            now: () => now,
            fetchImpl,
            resolveCredentials: async () => credentials
        })
        const template = DEFAULT_USAGE_QUERY_TEMPLATES[0]
        await service.saveSettings('claude', { enabled: true, templateId: template.id, template })

        const first = await service.query('claude')
        expect(first.status).toBe('success')
        expect(first.fiveHour?.usedPercent).toBe(75)
        expect(calls).toBe(1)

        now += 4 * 60_000
        await service.query('claude')
        expect(calls).toBe(1)

        now += 2 * 60_000
        await service.query('claude')
        expect(calls).toBe(2)
    })

    it('does not reuse cached data after credential rotation', async () => {
        root = await mkdtemp(join(tmpdir(), 'hapi-usage-service-'))
        let now = 1_780_000_000_000
        let activeCredentials = credentials
        let calls = 0
        const fetchImpl: UsageQueryFetch = async (_url, init) => {
            calls += 1
            expect(init.headers.Authorization).toBe(`Bearer ${activeCredentials.apiKey}`)
            return makeResponse(calls === 1 ? 25 : 50)
        }
        const service = new UsageQueryService({
            settingsFile: join(root, 'usage-query.json'),
            now: () => now,
            fetchImpl,
            resolveCredentials: async () => activeCredentials
        })
        const template = DEFAULT_USAGE_QUERY_TEMPLATES[0]
        await service.saveSettings('claude', { enabled: true, templateId: template.id, template })

        const first = await service.query('claude')
        expect(first.fiveHour?.usedPercent).toBe(75)
        activeCredentials = { ...credentials, apiKey: 'rotated-key' }
        now += 60_000
        const rotated = await service.query('claude')
        expect(rotated.fiveHour?.usedPercent).toBe(50)
        expect(calls).toBe(2)
    })

    it('retries a forced failure after cooldown even when the prior success is fresh', async () => {
        root = await mkdtemp(join(tmpdir(), 'hapi-usage-service-'))
        let now = 1_780_000_000_000
        let calls = 0
        const service = new UsageQueryService({
            settingsFile: join(root, 'usage-query.json'),
            now: () => now,
            fetchImpl: async () => {
                calls += 1
                if (calls === 1) return makeResponse(25)
                throw new Error('provider unavailable')
            },
            resolveCredentials: async () => credentials
        })
        const template = DEFAULT_USAGE_QUERY_TEMPLATES[0]
        await service.saveSettings('claude', { enabled: true, templateId: template.id, template })
        await service.query('claude')

        now += 60_000
        const forced = await service.query('claude', true)
        expect(forced).toMatchObject({ status: 'error', stale: true, fiveHour: { usedPercent: 75 } })
        expect(calls).toBe(2)

        now += 10_000
        await service.query('claude')
        expect(calls).toBe(2)

        now += 21_000
        const retried = await service.query('claude')
        expect(retried.status).toBe('error')
        expect(calls).toBe(3)
    })

    it('keeps stale windows after an error and suppresses automatic retries for 30 seconds', async () => {
        root = await mkdtemp(join(tmpdir(), 'hapi-usage-service-'))
        let now = 1_780_000_000_000
        let calls = 0
        const fetchImpl: UsageQueryFetch = async () => {
            calls += 1
            if (calls === 1) return makeResponse(10)
            throw new Error('provider unavailable')
        }
        const service = new UsageQueryService({
            settingsFile: join(root, 'usage-query.json'),
            now: () => now,
            fetchImpl,
            resolveCredentials: async () => credentials
        })
        const template = DEFAULT_USAGE_QUERY_TEMPLATES[0]
        await service.saveSettings('claude', { enabled: true, templateId: template.id, template })
        await service.query('claude')

        now += 5 * 60_000
        const failed = await service.query('claude')
        expect(failed).toMatchObject({ status: 'error', stale: true, fiveHour: { usedPercent: 90 } })
        expect(failed.error).toContain('provider unavailable')
        expect(calls).toBe(2)

        now += 10_000
        await service.query('claude')
        expect(calls).toBe(2)

        const forced = await service.query('claude', true)
        expect(forced.status).toBe('error')
        expect(calls).toBe(3)
    })

    it('does not reuse stale data after switching templates', async () => {
        root = await mkdtemp(join(tmpdir(), 'hapi-usage-service-'))
        let now = 1_780_000_000_000
        let calls = 0
        let fail = false
        const fetchImpl: UsageQueryFetch = async () => {
            calls += 1
            if (fail) throw new Error('new template unavailable')
            return makeResponse(0)
        }
        const service = new UsageQueryService({
            settingsFile: join(root, 'usage-query.json'),
            now: () => now,
            fetchImpl,
            resolveCredentials: async () => credentials
        })
        const first = DEFAULT_USAGE_QUERY_TEMPLATES[0]
        await service.saveSettings('claude', { enabled: true, templateId: first.id, template: first })
        await service.query('claude')

        const second: UsageQueryTemplate = {
            ...first,
            name: 'Changed template'
        }
        fail = true
        await service.saveSettings('claude', { enabled: true, templateId: second.id, template: second })
        const result = await service.query('claude')
        expect(result).toMatchObject({ status: 'error', templateId: second.id, fiveHour: null, sevenDay: null, stale: false })
        expect(calls).toBe(2)
    })

    it('does not reuse an in-flight request after switching templates', async () => {
        root = await mkdtemp(join(tmpdir(), 'hapi-usage-service-'))
        let calls = 0
        let releaseFirst!: () => void
        let firstStarted!: () => void
        const firstStartedPromise = new Promise<void>((resolve) => { firstStarted = resolve })
        const fetchImpl: UsageQueryFetch = async () => {
            calls += 1
            if (calls === 1) {
                firstStarted()
                return await new Promise((resolve) => { releaseFirst = () => resolve(makeResponse(10)) })
            }
            return makeResponse(50)
        }
        const service = new UsageQueryService({
            settingsFile: join(root, 'usage-query.json'),
            fetchImpl,
            resolveCredentials: async () => credentials
        })
        const first = DEFAULT_USAGE_QUERY_TEMPLATES[0]
        await service.saveSettings('claude', { enabled: true, templateId: first.id, template: first })
        const firstRequest = service.query('claude')
        await firstStartedPromise

        const second: UsageQueryTemplate = { ...first, name: 'Changed while querying' }
        await service.saveSettings('claude', { enabled: true, templateId: second.id, template: second })
        const secondResult = await service.query('claude')
        expect(secondResult.fiveHour?.usedPercent).toBe(50)
        expect(calls).toBe(2)

        releaseFirst()
        const firstResult = await firstRequest
        expect(firstResult.fiveHour?.usedPercent).toBe(90)

        const thirdResult = await service.query('claude')
        expect(thirdResult.fiveHour?.usedPercent).toBe(50)
        expect(calls).toBe(2)
    })

    it('does not join an in-flight request after credential rotation', async () => {
        root = await mkdtemp(join(tmpdir(), 'hapi-usage-service-'))
        let activeCredentials = credentials
        let calls = 0
        let releaseFirst!: () => void
        let firstStarted!: () => void
        const firstStartedPromise = new Promise<void>((resolve) => { firstStarted = resolve })
        const fetchImpl: UsageQueryFetch = async (_url, init) => {
            calls += 1
            expect(init.headers.Authorization).toBe(`Bearer ${activeCredentials.apiKey}`)
            if (calls === 1) {
                firstStarted()
                return await new Promise((resolve) => { releaseFirst = () => resolve(makeResponse(10)) })
            }
            return makeResponse(50)
        }
        const service = new UsageQueryService({
            settingsFile: join(root, 'usage-query.json'),
            fetchImpl,
            resolveCredentials: async () => activeCredentials
        })
        const template = DEFAULT_USAGE_QUERY_TEMPLATES[0]
        await service.saveSettings('claude', { enabled: true, templateId: template.id, template })
        const firstRequest = service.query('claude')
        await firstStartedPromise

        activeCredentials = { ...credentials, apiKey: 'rotated-key' }
        const rotatedResult = await service.query('claude')
        expect(rotatedResult.fiveHour?.usedPercent).toBe(50)
        expect(calls).toBe(2)

        releaseFirst()
        const firstResult = await firstRequest
        expect(firstResult.fiveHour?.usedPercent).toBe(90)
        const cachedRotated = await service.query('claude')
        expect(cachedRotated.fiveHour?.usedPercent).toBe(50)
        expect(calls).toBe(2)
    })

    it('redacts credentials from provider error messages', async () => {
        root = await mkdtemp(join(tmpdir(), 'hapi-usage-service-'))
        const service = new UsageQueryService({
            settingsFile: join(root, 'usage-query.json'),
            fetchImpl: async () => { throw new Error(`request failed for ${credentials.apiKey}`) },
            resolveCredentials: async () => credentials
        })
        const template = DEFAULT_USAGE_QUERY_TEMPLATES[0]
        await service.saveSettings('claude', { enabled: true, templateId: template.id, template })
        const result = await service.query('claude')
        expect(result.error).toBe('request failed for [redacted]')
    })

    it('redacts literal credentials from templates returned to Web', async () => {
        root = await mkdtemp(join(tmpdir(), 'hapi-usage-service-'))
        const service = new UsageQueryService({
            settingsFile: join(root, 'usage-query.json'),
            resolveCredentials: async () => credentials
        })
        const template = {
            ...DEFAULT_USAGE_QUERY_TEMPLATES[0],
            request: {
                ...DEFAULT_USAGE_QUERY_TEMPLATES[0].request,
                url: `${credentials.baseUrl}/usage`,
                headers: { Authorization: `Bearer ${credentials.apiKey}` }
            }
        }
        await service.saveSettings('claude', { enabled: false, templateId: template.id, template })
        const returned = await service.getSettings('claude')
        expect(returned.template.request.url).toBe('{{baseUrl}}/usage')
        expect(returned.template.request.headers.Authorization).toBe('Bearer {{apiKey}}')
        expect(await readFile(join(root, 'usage-query.json'), 'utf8')).not.toContain(credentials.apiKey)
    })

    it('preserves the separator when redacting slash-terminated base URLs', async () => {
        root = await mkdtemp(join(tmpdir(), 'hapi-usage-service-'))
        const slashCredentials = { ...credentials, baseUrl: 'https://provider.example/' }
        const service = new UsageQueryService({
            settingsFile: join(root, 'usage-query.json'),
            resolveCredentials: async () => slashCredentials
        })
        const template = {
            ...DEFAULT_USAGE_QUERY_TEMPLATES[0],
            request: {
                ...DEFAULT_USAGE_QUERY_TEMPLATES[0].request,
                url: 'https://provider.example/usage'
            }
        }
        await service.saveSettings('claude', { enabled: false, templateId: template.id, template })
        expect((await service.getSettings('claude')).template.request.url).toBe('{{baseUrl}}/usage')
    })

    it('serializes concurrent Claude and Codex settings writes', async () => {
        root = await mkdtemp(join(tmpdir(), 'hapi-usage-service-'))
        const service = new UsageQueryService({
            settingsFile: join(root, 'usage-query.json'),
            resolveCredentials: async () => credentials
        })
        const template = DEFAULT_USAGE_QUERY_TEMPLATES[0]
        await Promise.all([
            service.saveSettings('claude', { enabled: true, templateId: template.id, template }),
            service.saveSettings('codex', { enabled: true, templateId: template.id, template })
        ])
        expect((await service.getSettings('claude')).enabled).toBe(true)
        expect((await service.getSettings('codex')).enabled).toBe(true)
    })

    it('migrates a v1 settings file without dropping Claude and Codex entries', async () => {
        root = await mkdtemp(join(tmpdir(), 'hapi-usage-service-'))
        const template = DEFAULT_USAGE_QUERY_TEMPLATES[0]
        await writeFile(join(root, 'usage-query.json'), JSON.stringify({
            claude: { enabled: true, templateId: template.id, template },
            codex: { enabled: false, templateId: template.id, template }
        }))
        const service = new UsageQueryService({
            settingsFile: join(root, 'usage-query.json'),
            resolveCredentials: async () => credentials
        })
        expect((await service.getSettings('claude')).enabled).toBe(true)
        expect((await service.getSettings('kimi')).enabled).toBe(false)
    })
})
