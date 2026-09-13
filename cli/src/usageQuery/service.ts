import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import {
    DEFAULT_USAGE_QUERY_TEMPLATE,
    USAGE_QUERY_CACHE_TTL_MS,
    USAGE_QUERY_RETRY_COOLDOWN_MS,
    UsageQueryAgentSettingsSchema,
    UsageQuerySettingsSchema,
    UsageQueryTemplateSchema,
    type UsageQueryAgent,
    type UsageQueryAgentSettings,
    type UsageQueryResult,
    type UsageQuerySettings,
    type UsageQuerySettingsResponse,
    type UsageQueryTemplate
} from '@hapi/protocol/usageQuery'
import { z } from 'zod'
import { resolveUsageCredentials, type ResolvedUsageCredentials } from './credentials'
import { executeUsageQueryTemplate, type UsageQueryFetch, UsageQueryExecutionError } from './execute'

type UsageQueryServiceOptions = {
    settingsFile: string
    now?: () => number
    fetchImpl?: UsageQueryFetch
    resolveCredentials?: (agent: UsageQueryAgent) => Promise<ResolvedUsageCredentials>
}

type CachedResult = {
    templateId: string
    queryFingerprint: string
    result: UsageQueryResult
    cachedAt: number
    lastAttemptAt: number
    lastError: string | null
}

type InFlightRequest = {
    fingerprint: string
    request: Promise<UsageQueryResult>
}

function queryFingerprint(template: UsageQueryTemplate, credentials: ResolvedUsageCredentials): string {
    // Keep credentials in the in-memory identity so a long-lived Runner cannot
    // reuse or join quota data after an Agent account/configuration changes.
    return createHash('sha256')
        .update(JSON.stringify(template))
        .update('\0')
        .update(credentials.baseUrl)
        .update('\0')
        .update(credentials.apiKey)
        .digest('hex')
}

function cloneTemplate(template: UsageQueryTemplate): UsageQueryTemplate {
    return {
        ...template,
        request: {
            ...template.request,
            headers: { ...template.request.headers }
        },
        fiveHour: { ...template.fiveHour },
        sevenDay: { ...template.sevenDay }
    }
}

function redactTemplateCredentials(template: UsageQueryTemplate, credentials: ResolvedUsageCredentials): UsageQueryTemplate {
    const replacements: Array<[string, string]> = []
    if (credentials.apiKey) replacements.push([credentials.apiKey, '{{apiKey}}'])
    if (credentials.baseUrl) {
        const normalizedBaseUrl = credentials.baseUrl.replace(/\/+$/, '')
        if (normalizedBaseUrl) replacements.push([normalizedBaseUrl, '{{baseUrl}}'])
    }
    if (replacements.length === 0) return cloneTemplate(template)

    const redact = (value: string): string => replacements.reduce((result, [secret, placeholder]) => result.replaceAll(secret, placeholder), value)
    const cloned = cloneTemplate(template)
    cloned.request.url = redact(cloned.request.url)
    cloned.request.headers = Object.fromEntries(
        Object.entries(cloned.request.headers).map(([name, value]) => [name, redact(value)])
    )
    return cloned
}

function defaultAgentSettings(): UsageQueryAgentSettings {
    const template = cloneTemplate(DEFAULT_USAGE_QUERY_TEMPLATE)
    return {
        enabled: false,
        templateId: template.id,
        template
    }
}

function defaultSettings(): UsageQuerySettings {
    const agent = defaultAgentSettings()
    return {
        claude: agent,
        codex: cloneAgentSettings(agent),
        kimi: cloneAgentSettings(agent)
    }
}

function cloneAgentSettings(settings: UsageQueryAgentSettings): UsageQueryAgentSettings {
    return {
        enabled: settings.enabled,
        templateId: settings.templateId,
        template: cloneTemplate(settings.template)
    }
}

function sanitizeError(error: unknown, credentials?: ResolvedUsageCredentials): string {
    let message = error instanceof UsageQueryExecutionError
        ? error.message
        : error instanceof Error ? error.message : 'Usage query failed'
    const normalizedBaseUrl = credentials?.baseUrl?.replace(/\/+$/, '')
    for (const secret of [credentials?.apiKey, credentials?.baseUrl, normalizedBaseUrl]) {
        if (secret) message = message.replaceAll(secret, '[redacted]')
    }
    return message.length > 500 ? message.slice(0, 500) : message
}

function emptyResult(agent: UsageQueryAgent, templateId: string, now: number, error: string, previous?: UsageQueryResult): UsageQueryResult {
    return {
        agent,
        templateId,
        status: 'error',
        fiveHour: previous?.fiveHour ?? null,
        sevenDay: previous?.sevenDay ?? null,
        queriedAt: now,
        stale: Boolean(previous),
        error
    }
}

export class UsageQueryService {
    private readonly now: () => number
    private readonly fetchImpl?: UsageQueryFetch
    private readonly resolveCredentials: (agent: UsageQueryAgent) => Promise<ResolvedUsageCredentials>
    private readonly settingsFile: string
    private readonly cache = new Map<UsageQueryAgent, CachedResult>()
    private readonly inFlight = new Map<UsageQueryAgent, InFlightRequest>()
    private settingsWriteQueue: Promise<void> = Promise.resolve()

    constructor(options: UsageQueryServiceOptions) {
        this.settingsFile = options.settingsFile
        this.now = options.now ?? Date.now
        this.fetchImpl = options.fetchImpl
        this.resolveCredentials = options.resolveCredentials ?? ((agent) => resolveUsageCredentials(agent))
    }

    async getSettings(agent: UsageQueryAgent): Promise<UsageQuerySettingsResponse> {
        const settings = await this.readSettings()
        const configured = settings[agent]
        const credentials = await this.resolveCredentials(agent)
        return {
            agent,
            enabled: configured.enabled,
            templateId: configured.templateId,
            template: redactTemplateCredentials(configured.template, credentials),
            credentials: {
                baseUrl: {
                    configured: Boolean(credentials.baseUrl),
                    source: credentials.baseUrl ? credentials.baseUrlSource : 'none'
                },
                apiKey: {
                    configured: Boolean(credentials.apiKey),
                    source: credentials.apiKey ? credentials.apiKeySource : 'none'
                }
            }
        }
    }

    async saveSettings(
        agent: UsageQueryAgent,
        input: Omit<UsageQueryAgentSettings, 'templateId'> & { templateId: string }
    ): Promise<UsageQuerySettingsResponse> {
        const parsedTemplate = UsageQueryTemplateSchema.parse(input.template)
        if (parsedTemplate.id !== input.templateId) {
            throw new UsageQueryExecutionError('Template ID does not match template content')
        }
        const credentials = await this.resolveCredentials(agent)
        const template = redactTemplateCredentials(parsedTemplate, credentials)
        return await this.withSettingsWrite(async () => {
            const settings = await this.readSettings()
            settings[agent] = UsageQueryAgentSettingsSchema.parse({
                enabled: input.enabled,
                templateId: input.templateId,
                template
            })
            await this.writeSettings(settings)
            this.cache.delete(agent)
            return await this.getSettings(agent)
        })
    }

    async test(agent: UsageQueryAgent, template: UsageQueryTemplate): Promise<UsageQueryResult> {
        const parsedTemplate = UsageQueryTemplateSchema.parse(template)
        let credentials: ResolvedUsageCredentials | undefined
        try {
            credentials = await this.resolveCredentials(agent)
            return await executeUsageQueryTemplate(agent, parsedTemplate, credentials, {
                fetchImpl: this.fetchImpl,
                now: this.now()
            })
        } catch (error) {
            return emptyResult(agent, parsedTemplate.id, this.now(), sanitizeError(error, credentials))
        }
    }

    async query(agent: UsageQueryAgent, force = false): Promise<UsageQueryResult> {
        const settings = await this.readSettings()
        const configured = settings[agent]
        const now = this.now()
        const cached = this.cache.get(agent)
        if (!configured.enabled) {
            return emptyResult(agent, configured.templateId, now, 'Usage query is disabled')
        }
        let credentials: ResolvedUsageCredentials
        try {
            credentials = await this.resolveCredentials(agent)
        } catch (error) {
            return emptyResult(agent, configured.templateId, now, sanitizeError(error))
        }
        // A saved template change invalidates the old value semantically even
        // before the in-memory cache entry is cleared (for example, when a
        // settings write races an already-running query). Credential changes
        // use the same rule, so never present another account's stale data.
        const fingerprint = queryFingerprint(configured.template, credentials)
        const usableCached = cached !== undefined
            && cached.templateId === configured.templateId
            && cached.queryFingerprint === fingerprint
            ? cached
            : undefined
        if (!force && usableCached) {
            if (usableCached.lastError) {
                if (now - usableCached.lastAttemptAt < USAGE_QUERY_RETRY_COOLDOWN_MS) return usableCached.result
            } else if (now - usableCached.cachedAt < USAGE_QUERY_CACHE_TTL_MS) {
                return usableCached.result
            }
        }
        const existing = this.inFlight.get(agent)
        if (existing?.fingerprint === fingerprint) return await existing.request

        const request = this.runQuery(agent, configured, credentials, usableCached, now, fingerprint)
        this.inFlight.set(agent, { fingerprint, request })
        try {
            return await request
        } finally {
            if (this.inFlight.get(agent)?.request === request) this.inFlight.delete(agent)
        }
    }

    private async runQuery(
        agent: UsageQueryAgent,
        configured: UsageQueryAgentSettings,
        credentials: ResolvedUsageCredentials,
        cached: CachedResult | undefined,
        startedAt: number,
        fingerprint: string
    ): Promise<UsageQueryResult> {
        try {
            const result = await executeUsageQueryTemplate(agent, configured.template, credentials, {
                fetchImpl: this.fetchImpl,
                now: startedAt
            })
            if (this.inFlight.get(agent)?.fingerprint === fingerprint) {
                this.cache.set(agent, {
                    templateId: configured.templateId,
                    queryFingerprint: fingerprint,
                    result,
                    cachedAt: startedAt,
                    lastAttemptAt: startedAt,
                    lastError: null
                })
            }
            return result
        } catch (error) {
            const message = sanitizeError(error, credentials)
            const result = emptyResult(agent, configured.templateId, startedAt, message, cached?.result)
            if (this.inFlight.get(agent)?.fingerprint === fingerprint) {
                this.cache.set(agent, {
                    templateId: configured.templateId,
                    queryFingerprint: fingerprint,
                    result,
                    cachedAt: cached?.cachedAt ?? 0,
                    lastAttemptAt: startedAt,
                    lastError: message
                })
            }
            return result
        }
    }

    private async readSettings(): Promise<UsageQuerySettings> {
        try {
            const parsed: unknown = JSON.parse(await readFile(this.settingsFile, 'utf8'))
            const result = UsageQuerySettingsSchema.safeParse(parsed)
            if (result.success) return result.data
            // Migrate the two-agent v1 settings file without dropping the
            // user's existing Claude/Codex templates when Kimi support is
            // added.
            const legacy = z.object({
                claude: UsageQueryAgentSettingsSchema,
                codex: UsageQueryAgentSettingsSchema
            }).strict().safeParse(parsed)
            if (legacy.success) {
                return {
                    ...legacy.data,
                    kimi: defaultAgentSettings()
                }
            }
            return defaultSettings()
        } catch {
            return defaultSettings()
        }
    }

    private async writeSettings(settings: UsageQuerySettings): Promise<void> {
        const parsed = UsageQuerySettingsSchema.parse(settings)
        await mkdir(dirname(this.settingsFile), { recursive: true })
        await chmod(dirname(this.settingsFile), 0o700).catch(() => {})
        const temporary = `${this.settingsFile}.${randomUUID()}.tmp`
        try {
            await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
            await rename(temporary, this.settingsFile)
        } finally {
            await unlink(temporary).catch(() => {})
        }
    }

    /** Serialize read-modify-write settings updates within this Runner. */
    private async withSettingsWrite<T>(work: () => Promise<T>): Promise<T> {
        const previous = this.settingsWriteQueue
        let release!: () => void
        this.settingsWriteQueue = new Promise<void>((resolve) => { release = resolve })
        await previous
        try {
            return await work()
        } finally {
            release()
        }
    }
}
