import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type {
    AgentQuotaAccount,
    AgentQuotaBucket,
    AgentQuotasResponse
} from '@hapi/protocol/apiTypes'
import { buildAgyAcpEnv } from '@/agy/utils/agyAcpBackend'
import { getDefaultClaudeCodePath } from '@/claude/sdk/utils'
import { CodexAppServerClient } from '@/codex/codexAppServerClient'
import type {
    AccountRateLimitsReadResponse,
    AccountReadResponse,
    CodexRateLimitEntry,
    CodexRateLimitWindow
} from '@/codex/appServerTypes'
import { resolveHapiHomeDir } from '@/configuration'
import { withBunRuntimeEnv } from '@/utils/bunRuntime'
import { killProcessByChildProcess } from '@/utils/process'
import { getAgentAvailability } from './agentAvailability'
import { getAgentLaunchCommand } from './agentLaunchCommand'

const CACHE_TTL_MS = 60_000
const DEFAULT_PROVIDER_PROBE_TIMEOUT_MS = 5_000
const AGY_PROBE_TIMEOUT_MS = DEFAULT_PROVIDER_PROBE_TIMEOUT_MS
const CLAUDE_PROBE_TIMEOUT_MS = DEFAULT_PROVIDER_PROBE_TIMEOUT_MS
const CLAUDE_INIT_REQ_ID = 'hapi-claude-quota-init'
const CLAUDE_STATUS_REQ_ID = 'hapi-claude-quota-status'

type RecordValue = Record<string, unknown>

function asRecord(value: unknown): RecordValue | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as RecordValue
        : null
}

function asNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function asFiniteNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function clampPercent(value: number): number {
    return Math.max(0, Math.min(100, Math.round(value * 10) / 10))
}

function normalizeResetTimestampMs(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        return value < 1_000_000_000_000 ? Math.round(value * 1000) : Math.round(value)
    }
    if (typeof value === 'string' && value.trim()) {
        const parsed = Date.parse(value.trim())
        if (Number.isFinite(parsed) && parsed > 0) {
            return parsed
        }
    }
    return null
}

function formatPlanName(raw: string | null | undefined): string | null {
    if (!raw || !raw.trim()) return null
    const trimmed = raw.trim()
    const lower = trimmed.toLowerCase()
    if (lower === 'pro') return 'Pro'
    if (lower === 'plus') return 'Plus'
    if (lower === 'team') return 'Team'
    if (lower === 'enterprise') return 'Enterprise'
    if (lower === 'free') return 'Free'
    if (lower === 'max') return 'Max'
    return trimmed
}

function formatWindowMinutes(mins: number | null | undefined): { window: string | null; label: string } {
    if (!mins || mins <= 0) return { window: null, label: 'Rate limit' }
    if (mins === 300) return { window: '5h', label: '5h window' }
    if (mins === 10080) return { window: 'weekly', label: 'Weekly (7d)' }
    if (mins === 1440) return { window: '24h', label: 'Daily (24h)' }
    if (mins % 1440 === 0) {
        const days = mins / 1440
        return { window: `${days}d`, label: `${days}d window` }
    }
    if (mins % 60 === 0) {
        const hours = mins / 60
        return { window: `${hours}h`, label: `${hours}h window` }
    }
    return { window: `${mins}m`, label: `${mins}m window` }
}

function formatCodexCredits(
    rateLimits: CodexRateLimitEntry | null | undefined,
    resetCreditsCount: number | null | undefined
): string | null {
    const parts: string[] = []
    const credits = rateLimits?.credits
    if (credits?.unlimited === true) {
        parts.push('Unlimited credits')
    } else if (credits?.hasCredits && credits.balance !== null && credits.balance !== undefined) {
        const num = typeof credits.balance === 'number' ? credits.balance : Number(credits.balance)
        if (Number.isFinite(num)) {
            parts.push(`${num.toLocaleString('en-US', { maximumFractionDigits: 2 })} credits`)
        }
    }
    if (typeof resetCreditsCount === 'number' && Number.isFinite(resetCreditsCount) && resetCreditsCount > 0) {
        parts.push(`${resetCreditsCount} free reset${resetCreditsCount === 1 ? '' : 's'}`)
    }
    return parts.length > 0 ? parts.join(' · ') : null
}

function parseCodexWindowBucket(
    id: string,
    windowObj: CodexRateLimitWindow | null | undefined,
    prefixLabel?: string | null
): AgentQuotaBucket | null {
    if (!windowObj || typeof windowObj !== 'object') return null
    const usedRaw = asFiniteNumber(windowObj.usedPercent ?? (windowObj as RecordValue).used_percent)
    if (usedRaw === null) return null
    const usedPercent = clampPercent(usedRaw)
    const remainingPercent = clampPercent(100 - usedPercent)
    const durationMins = asFiniteNumber(windowObj.windowDurationMins ?? (windowObj as RecordValue).window_duration_mins)
    const { window, label: windowLabel } = formatWindowMinutes(durationMins)
    const resetsAt = normalizeResetTimestampMs(windowObj.resetsAt ?? (windowObj as RecordValue).resets_at)
    const label = prefixLabel ? `${prefixLabel} · ${windowLabel}` : windowLabel
    return {
        id,
        label,
        group: prefixLabel ?? null,
        window,
        usedPercent,
        remainingPercent,
        resetsAt
    }
}

export function extractCodexQuotaBuckets(response: AccountRateLimitsReadResponse | null | undefined): AgentQuotaBucket[] {
    if (!response) return []
    const buckets: AgentQuotaBucket[] = []
    const seen = new Set<string>()

    const addEntryBuckets = (entry: CodexRateLimitEntry | null | undefined, keyPrefix: string, groupLabel?: string | null) => {
        if (!entry) return
        const primary = parseCodexWindowBucket(`${keyPrefix}-primary`, entry.primary, groupLabel)
        if (primary) {
            const sig = `${primary.group ?? ''}|${primary.window ?? ''}|${primary.usedPercent}|${primary.resetsAt ?? ''}`
            if (!seen.has(sig)) {
                seen.add(sig)
                buckets.push(primary)
            }
        }
        const secondary = parseCodexWindowBucket(`${keyPrefix}-secondary`, entry.secondary, groupLabel)
        if (secondary) {
            const sig = `${secondary.group ?? ''}|${secondary.window ?? ''}|${secondary.usedPercent}|${secondary.resetsAt ?? ''}`
            if (!seen.has(sig)) {
                seen.add(sig)
                buckets.push(secondary)
            }
        }
    }

    addEntryBuckets(response.rateLimits, response.rateLimits?.limitId ?? 'codex', response.rateLimits?.limitName ?? null)

    if (response.rateLimitsByLimitId && typeof response.rateLimitsByLimitId === 'object') {
        for (const [limitId, entry] of Object.entries(response.rateLimitsByLimitId)) {
            const groupLabel = asNonEmptyString(entry?.limitName) ?? (limitId !== 'codex' ? limitId : null)
            addEntryBuckets(entry, limitId, groupLabel)
        }
    }

    return buckets
}

// Live in-memory observations + cross-process per-observation atomic files under HAPI_HOME/agent-quotas-live
type LiveClaudeBucketRecord = AgentQuotaBucket & {
    updatedAt: number
    accountKey: string
    rateLimitType: string
}

type PersistedLiveQuotaState = {
    codexUpdatedAt?: number
    claudeBuckets?: Record<string, LiveClaudeBucketRecord>
    agyTierLabel?: string | null
    agyUpdatedAt?: number
}

let cachedResponse: { startedAt: number; expiresAt: number; response: AgentQuotasResponse } | null = null
let inflightPromise: Promise<AgentQuotasResponse> | null = null
const liveClaudeBuckets = new Map<string, LiveClaudeBucketRecord>()
let liveAgyTierLabel: string | null = null

function shortHash(value: string): string {
    return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function sanitizeKeySegment(value: string): string {
    return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48) || 'default'
}

function resolveLiveQuotaStateDir(env: NodeJS.ProcessEnv = process.env): string | null {
    if (env.VITEST === 'true' && !env.HAPI_HOME) {
        return null
    }
    return join(resolveHapiHomeDir(env), 'agent-quotas-live')
}

function writeAtomicJsonFile(filePath: string, payload: unknown): void {
    try {
        mkdirSync(dirname(filePath), { recursive: true })
        const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
        writeFileSync(tmpPath, JSON.stringify(payload), 'utf8')
        renameSync(tmpPath, filePath)
    } catch {
        // Best-effort cross-process state persistence
    }
}

export function resolveClaudeEnvCredentialKey(env: NodeJS.ProcessEnv = process.env): string | null {
    const token = asNonEmptyString(env.CLAUDE_CODE_OAUTH_TOKEN)
        ?? asNonEmptyString(env.ANTHROPIC_AUTH_TOKEN)
        ?? asNonEmptyString(env.ANTHROPIC_API_KEY)
    if (!token) return null
    return `cred:${shortHash(token)}`
}

function normalizeClaudeAccountKey(rawIdentity: string | null | undefined): string | null {
    const trimmed = asNonEmptyString(rawIdentity)
    if (!trimmed) return null
    const lower = trimmed.toLowerCase()
    if (lower.startsWith('auth:')) {
        return null
    }
    if (
        lower.startsWith('acct:')
        || lower.startsWith('cred:')
        || lower.startsWith('url:')
        || lower.startsWith('org:')
    ) {
        return lower
    }
    if (lower.startsWith('http://') || lower.startsWith('https://')) {
        return `url:${lower}`
    }
    return `acct:${lower}`
}

function readClaudeConfigAccountKey(env: NodeJS.ProcessEnv = process.env): string | null {
    const configDir = asNonEmptyString(env.CLAUDE_CONFIG_DIR)
    const home = asNonEmptyString(env.HOME) ?? (env.VITEST === 'true' ? null : homedir())
    const candidates: string[] = []
    if (configDir) {
        candidates.push(join(configDir, '.claude.json'))
    }
    if (home) {
        candidates.push(join(home, '.claude.json'))
    }
    for (const filePath of candidates) {
        if (!existsSync(filePath)) continue
        try {
            const parsed = asRecord(JSON.parse(readFileSync(filePath, 'utf8')))
            const oauthAccount = asRecord(parsed?.oauthAccount)
            const identity = asNonEmptyString(oauthAccount?.emailAddress)
                ?? asNonEmptyString(oauthAccount?.accountUuid)
            if (identity) {
                return `acct:${identity.toLowerCase()}`
            }
        } catch {
            // Ignore malformed config file
        }
    }
    return null
}

export function resolveClaudeSessionAccountKey(
    env: NodeJS.ProcessEnv = process.env,
    explicitIdentity?: string | null
): string | null {
    const explicit = normalizeClaudeAccountKey(explicitIdentity)
    if (explicit) return explicit
    const envCredKey = resolveClaudeEnvCredentialKey(env)
    if (envCredKey) return envCredKey
    const configKey = readClaudeConfigAccountKey(env)
    if (configKey) return configKey
    const baseUrl = asNonEmptyString(env.ANTHROPIC_BASE_URL)
    if (baseUrl) return `url:${baseUrl.toLowerCase()}`
    return null
}

function claudeBucketCompositeKey(accountKey: string, rateLimitType: string): string {
    return `${accountKey}::${rateLimitType}`
}

function claudeBucketFileName(accountKey: string, rateLimitType: string): string {
    return `claude-bucket-${shortHash(accountKey)}-${sanitizeKeySegment(rateLimitType)}.json`
}

function parsePersistedClaudeBucket(raw: unknown): LiveClaudeBucketRecord | null {
    const entry = asRecord(raw)
    if (!entry) return null
    const id = asNonEmptyString(entry.id)
    const label = asNonEmptyString(entry.label)
    const usedPercent = asFiniteNumber(entry.usedPercent)
    const remainingPercent = asFiniteNumber(entry.remainingPercent)
    const updatedAt = asFiniteNumber(entry.updatedAt)
    const accountKey = normalizeClaudeAccountKey(asNonEmptyString(entry.accountKey))
    if (!id || !label || usedPercent === null || remainingPercent === null || updatedAt === null || !accountKey) {
        return null
    }
    const rateLimitType = asNonEmptyString(entry.rateLimitType) ?? id.replace(/^claude-/, '')
    return {
        id,
        label,
        group: asNonEmptyString(entry.group),
        window: asNonEmptyString(entry.window),
        usedPercent,
        remainingPercent,
        resetsAt: asFiniteNumber(entry.resetsAt),
        updatedAt,
        accountKey,
        rateLimitType
    }
}

function readPersistedLiveQuotaState(env: NodeJS.ProcessEnv = process.env): PersistedLiveQuotaState {
    const dirPath = resolveLiveQuotaStateDir(env)
    if (!dirPath || !existsSync(dirPath)) return {}

    let codexUpdatedAt: number | undefined
    let agyTierLabel: string | null = null
    let agyUpdatedAt: number | undefined
    const claudeBuckets: Record<string, LiveClaudeBucketRecord> = {}

    try {
        const files = readdirSync(dirPath)
        for (const name of files) {
            if (!name.endsWith('.json') || name.endsWith('.tmp')) continue
            const fullPath = join(dirPath, name)
            try {
                const parsed = asRecord(JSON.parse(readFileSync(fullPath, 'utf8')))
                if (!parsed) continue
                if (name === 'codex.json') {
                    const ts = asFiniteNumber(parsed.updatedAt ?? parsed.codexUpdatedAt)
                    if (ts !== null && (codexUpdatedAt === undefined || ts > codexUpdatedAt)) {
                        codexUpdatedAt = ts
                    }
                } else if (name === 'agy.json') {
                    const tier = asNonEmptyString(parsed.tierLabel ?? parsed.agyTierLabel)
                    const ts = asFiniteNumber(parsed.updatedAt) ?? 0
                    if (tier && (agyUpdatedAt === undefined || ts >= agyUpdatedAt)) {
                        agyTierLabel = tier
                        agyUpdatedAt = ts
                    }
                } else if (name.startsWith('claude-bucket-')) {
                    const bucket = parsePersistedClaudeBucket(parsed)
                    if (bucket) {
                        const compKey = claudeBucketCompositeKey(bucket.accountKey, bucket.rateLimitType)
                        const prev = claudeBuckets[compKey]
                        if (!prev || bucket.updatedAt >= prev.updatedAt) {
                            claudeBuckets[compKey] = bucket
                        }
                    }
                }
            } catch {
                // Ignore individual file parse errors
            }
        }
    } catch {
        // Ignore directory read errors
    }

    return { codexUpdatedAt, claudeBuckets, agyTierLabel, agyUpdatedAt }
}

function getLatestLiveQuotaUpdateAt(env: NodeJS.ProcessEnv = process.env): number {
    const persisted = readPersistedLiveQuotaState(env)
    let latest = Math.max(persisted.codexUpdatedAt ?? 0, persisted.agyUpdatedAt ?? 0)
    if (persisted.claudeBuckets) {
        for (const entry of Object.values(persisted.claudeBuckets)) {
            if (entry.updatedAt > latest) {
                latest = entry.updatedAt
            }
        }
    }
    for (const entry of liveClaudeBuckets.values()) {
        if (entry.updatedAt > latest) {
            latest = entry.updatedAt
        }
    }
    return latest
}

export function recordCodexRateLimitsUpdate(params: unknown, env: NodeJS.ProcessEnv = process.env): void {
    const record = asRecord(params)
    if (!record) return
    const now = Date.now()
    cachedResponse = null
    const dirPath = resolveLiveQuotaStateDir(env)
    if (dirPath) {
        writeAtomicJsonFile(join(dirPath, 'codex.json'), { updatedAt: now })
    }
}

export function recordClaudeRateLimitEvent(
    info: unknown,
    env: NodeJS.ProcessEnv = process.env,
    accountIdentity?: string | null
): void {
    const record = asRecord(info)
    if (!record) return
    const status = asNonEmptyString(record.status)?.toLowerCase()
    const rawUtilization = asFiniteNumber(record.utilization)
    const effectiveUtilization = status === 'rejected'
        ? (rawUtilization !== null ? Math.max(1, rawUtilization) : 1)
        : rawUtilization
    if (effectiveUtilization === null) return

    const rateLimitType = asNonEmptyString(record.rateLimitType) ?? 'default'
    const explicitAccount = accountIdentity
        ?? asNonEmptyString(record.accountEmail)
        ?? asNonEmptyString(record.email)
    const accountKey = resolveClaudeSessionAccountKey(env, explicitAccount)
    cachedResponse = null
    if (!accountKey) {
        return
    }
    const compKey = claudeBucketCompositeKey(accountKey, rateLimitType)

    const existingInMemory = liveClaudeBuckets.get(compKey)
    const existingPersisted = readPersistedLiveQuotaState(env).claudeBuckets?.[compKey]
    const resetsAt = normalizeResetTimestampMs(record.resetsAt)
        ?? existingInMemory?.resetsAt
        ?? existingPersisted?.resetsAt
        ?? null

    const usedPercent = status === 'rejected'
        ? 100
        : clampPercent(effectiveUtilization <= 1 ? effectiveUtilization * 100 : effectiveUtilization)
    const remainingPercent = clampPercent(100 - usedPercent)
    const lowerType = rateLimitType.toLowerCase()
    const window = lowerType.includes('5h') || lowerType.includes('five_hour')
        ? '5h'
        : lowerType.includes('7d') || lowerType.includes('seven_day') || lowerType.includes('week')
            ? 'weekly'
            : rateLimitType
    const label = window === '5h'
        ? '5h window'
        : window === 'weekly'
            ? 'Weekly (7d)'
            : `Limit (${rateLimitType})`

    const bucketRecord: LiveClaudeBucketRecord = {
        id: `claude-${rateLimitType}`,
        label,
        group: null,
        window,
        usedPercent,
        remainingPercent,
        resetsAt,
        updatedAt: Date.now(),
        accountKey,
        rateLimitType
    }
    liveClaudeBuckets.set(compKey, bucketRecord)
    cachedResponse = null
    const dirPath = resolveLiveQuotaStateDir(env)
    if (dirPath) {
        writeAtomicJsonFile(join(dirPath, claudeBucketFileName(accountKey, rateLimitType)), bucketRecord)
    }
}

export function recordAgyTier(tierName: string | null | undefined, env: NodeJS.ProcessEnv = process.env): void {
    const normalized = asNonEmptyString(tierName)
    if (normalized) {
        liveAgyTierLabel = normalized
        cachedResponse = null
        const dirPath = resolveLiveQuotaStateDir(env)
        if (dirPath) {
            writeAtomicJsonFile(join(dirPath, 'agy.json'), {
                tierLabel: normalized,
                updatedAt: Date.now()
            })
        }
    }
}

export async function probeCodexQuota(
    env: NodeJS.ProcessEnv = process.env,
    timeoutMs: number = DEFAULT_PROVIDER_PROBE_TIMEOUT_MS
): Promise<AgentQuotaAccount> {
    const updatedAt = Date.now()
    const availability = getAgentAvailability('codex', env)
    if (!availability.available) {
        return {
            agent: 'codex',
            available: false,
            status: 'unavailable',
            buckets: [],
            updatedAt
        }
    }

    const client = new CodexAppServerClient({ cwd: homedir() })
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null
    const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
            reject(new Error('Codex quota probe timed out'))
        }, timeoutMs)
    })

    try {
        return await Promise.race([
            (async (): Promise<AgentQuotaAccount> => {
                await client.connect()
                await client.initialize({
                    clientInfo: {
                        name: 'hapi-codex-quota',
                        version: '1.0.0'
                    },
                    capabilities: {
                        experimentalApi: true
                    }
                })

                let accountReadError: unknown = null
                let rateLimitsReadError: unknown = null
                const [accountRes, rateLimitsRes] = await Promise.all([
                    client.readAccount().catch((error): AccountReadResponse => {
                        accountReadError = error
                        return {}
                    }),
                    client.readRateLimits().catch((error): AccountRateLimitsReadResponse => {
                        rateLimitsReadError = error
                        return {}
                    })
                ])

                const account = accountRes.account
                if (!account && accountRes.requiresOpenaiAuth) {
                    return {
                        agent: 'codex',
                        available: true,
                        status: 'unauthenticated',
                        buckets: [],
                        note: 'Not signed in to Codex',
                        updatedAt
                    }
                }

                const email = asNonEmptyString(account?.email)
                const accountType = asNonEmptyString(account?.type)
                const accountLabel = email ?? (accountType === 'apiKey' ? 'OpenAI API Key' : null)
                const planLabel = formatPlanName(
                    asNonEmptyString(account?.planType) ?? asNonEmptyString(rateLimitsRes.rateLimits?.planType)
                )
                const resetCount = asFiniteNumber(rateLimitsRes.rateLimitResetCredits?.availableCount)
                const creditsLabel = formatCodexCredits(rateLimitsRes.rateLimits, resetCount)
                const buckets = extractCodexQuotaBuckets(rateLimitsRes)

                if (accountType === 'apiKey' && buckets.length === 0 && !rateLimitsReadError) {
                    return {
                        agent: 'codex',
                        available: true,
                        status: 'custom_provider',
                        accountLabel,
                        planLabel: planLabel ?? 'API Key',
                        creditsLabel,
                        buckets: [],
                        note: 'Authenticated via OpenAI API key',
                        updatedAt
                    }
                }

                const readError = rateLimitsReadError ?? accountReadError
                if (readError !== null) {
                    return {
                        agent: 'codex',
                        available: true,
                        status: 'error',
                        accountLabel,
                        planLabel,
                        creditsLabel,
                        buckets,
                        note: readError instanceof Error ? readError.message : 'Failed to query Codex quota',
                        updatedAt
                    }
                }

                return {
                    agent: 'codex',
                    available: true,
                    status: 'ok',
                    accountLabel,
                    planLabel,
                    creditsLabel,
                    buckets,
                    note: rateLimitsRes.rateLimits?.spendControlReached ? 'Spend control limit reached' : null,
                    updatedAt
                }
            })(),
            timeoutPromise
        ])
    } catch (error) {
        return {
            agent: 'codex',
            available: true,
            status: 'error',
            buckets: [],
            note: error instanceof Error ? error.message : 'Failed to query Codex quota',
            updatedAt
        }
    } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle)
        // Bound disconnect cleanup so a hung subprocess cannot stall the RPC response
        await Promise.race([
            client.disconnect().catch(() => undefined),
            new Promise<void>((resolve) => setTimeout(resolve, 250))
        ])
    }
}

export function parseAgyUsageCommandJson(stdout: string): {
    buckets: AgentQuotaBucket[]
    unauthenticated?: boolean
} | null {
    const lower = stdout.toLowerCase()
    if (
        lower.includes('authentication required')
        || lower.includes('please sign in')
        || lower.includes('not logged in')
    ) {
        return { buckets: [], unauthenticated: true }
    }

    for (const line of stdout.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('{')) continue
        let parsed: unknown
        try {
            parsed = JSON.parse(trimmed)
        } catch {
            continue
        }
        const root = asRecord(parsed)
        const command = asRecord(root?.command)
        if (command?.name !== 'usage') continue
        const data = asRecord(command.data)
        const groups = Array.isArray(data?.groups) ? data.groups : []
        const buckets: AgentQuotaBucket[] = []

        for (const rawGroup of groups) {
            const group = asRecord(rawGroup)
            if (!group) continue
            const groupName = asNonEmptyString(group.name) ?? 'Models'
            const groupBuckets = Array.isArray(group.buckets) ? group.buckets : []
            for (const rawBucket of groupBuckets) {
                const bucket = asRecord(rawBucket)
                if (!bucket) continue
                const fraction = asFiniteNumber(bucket.remaining_fraction)
                if (fraction === null) continue
                const remainingPercent = clampPercent(fraction * 100)
                const usedPercent = clampPercent(100 - remainingPercent)
                const window = asNonEmptyString(bucket.window)
                const bucketName = asNonEmptyString(bucket.name) ?? (window ?? 'Quota')
                const shortWindow = window === '5h'
                    ? '5h'
                    : window === 'weekly'
                        ? 'Weekly'
                        : bucketName
                const id = asNonEmptyString(bucket.id) ?? `${groupName}-${shortWindow}`
                const resetsAt = normalizeResetTimestampMs(bucket.reset_time)
                buckets.push({
                    id,
                    label: `${groupName} · ${shortWindow}`,
                    group: groupName,
                    window,
                    usedPercent,
                    remainingPercent,
                    resetsAt
                })
            }
        }
        return { buckets }
    }
    return null
}

export function parseAgyCreditsCommandJson(stdout: string): number | null {
    for (const line of stdout.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('{')) continue
        let parsed: unknown
        try {
            parsed = JSON.parse(trimmed)
        } catch {
            continue
        }
        const root = asRecord(parsed)
        const command = asRecord(root?.command)
        if (command?.name !== 'credits') continue
        const data = asRecord(command.data)
        const remaining = asFiniteNumber(data?.remaining_credits)
        if (remaining !== null) return remaining
    }
    return null
}

function runAgyHeadlessCommand(command: string, promptCommand: string, env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, ['-p', promptCommand, '--output-format', 'json'], {
            cwd: homedir(),
            env: buildAgyAcpEnv(env),
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: false,
            windowsHide: process.platform === 'win32'
        })

        let stdout = ''
        let stderr = ''
        let settled = false

        const finish = (cb: () => void) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            cb()
        }

        const timer = setTimeout(() => {
            void killProcessByChildProcess(child, true).catch(() => undefined)
            finish(() => reject(new Error(`Antigravity ${promptCommand} timed out`)))
        }, AGY_PROBE_TIMEOUT_MS)

        child.stdout?.on('data', (chunk) => {
            stdout += chunk.toString()
        })
        child.stderr?.on('data', (chunk) => {
            stderr += chunk.toString()
        })
        child.on('error', (error) => {
            finish(() => reject(error))
        })
        child.on('close', () => {
            finish(() => resolve({ stdout, stderr }))
        })
    })
}

export async function probeAgyQuota(env: NodeJS.ProcessEnv = process.env): Promise<AgentQuotaAccount> {
    const updatedAt = Date.now()
    const availability = getAgentAvailability('agy', env)
    if (!availability.available) {
        return {
            agent: 'agy',
            available: false,
            status: 'unavailable',
            buckets: [],
            updatedAt
        }
    }

    const executable = getAgentLaunchCommand('agy', env)
    try {
        const [usageOut, creditsOut] = await Promise.all([
            runAgyHeadlessCommand(executable, '/usage', env),
            runAgyHeadlessCommand(executable, '/credits', env).catch(() => ({ stdout: '', stderr: '' }))
        ])

        const parsedUsage = parseAgyUsageCommandJson(`${usageOut.stdout}\n${usageOut.stderr}`)
        if (parsedUsage?.unauthenticated) {
            return {
                agent: 'agy',
                available: true,
                status: 'unauthenticated',
                buckets: [],
                note: 'Not signed in to Antigravity',
                updatedAt
            }
        }

        if (!parsedUsage) {
            return {
                agent: 'agy',
                available: true,
                status: 'error',
                buckets: [],
                note: 'Unable to parse Antigravity quota output',
                updatedAt
            }
        }

        const remainingCredits = parseAgyCreditsCommandJson(creditsOut.stdout)
        const creditsLabel = remainingCredits !== null && remainingCredits > 0
            ? `${remainingCredits.toLocaleString('en-US')} G1 credits`
            : null

        return {
            agent: 'agy',
            available: true,
            status: 'ok',
            accountLabel: null,
            planLabel: liveAgyTierLabel ?? readPersistedLiveQuotaState(env).agyTierLabel ?? null,
            creditsLabel,
            buckets: parsedUsage.buckets,
            updatedAt
        }
    } catch (error) {
        return {
            agent: 'agy',
            available: true,
            status: 'error',
            buckets: [],
            note: error instanceof Error ? error.message : 'Failed to query Antigravity quota',
            updatedAt
        }
    }
}

type ClaudeControlProbeResult = {
    account: RecordValue | null
    statusRows: Map<string, string>
}

export function parseClaudeQuotaControlLine(
    line: string,
    target: ClaudeControlProbeResult
): { initDone: boolean; statusDone: boolean } {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) return { initDone: false, statusDone: false }
    let parsed: unknown
    try {
        parsed = JSON.parse(trimmed)
    } catch {
        return { initDone: false, statusDone: false }
    }
    const message = asRecord(parsed)
    if (message?.type !== 'control_response') return { initDone: false, statusDone: false }
    const response = asRecord(message.response)
    const reqId = asNonEmptyString(response?.request_id)
    const inner = asRecord(response?.response)

    if (reqId === CLAUDE_INIT_REQ_ID) {
        target.account = asRecord(inner?.account)
        return { initDone: true, statusDone: false }
    }
    if (reqId === CLAUDE_STATUS_REQ_ID) {
        const sections = Array.isArray(inner?.sections) ? inner.sections : []
        for (const rawSection of sections) {
            const section = asRecord(rawSection)
            const rows = Array.isArray(section?.rows) ? section.rows : []
            for (const rawRow of rows) {
                const row = asRecord(rawRow)
                const label = asNonEmptyString(row?.label)
                const value = asNonEmptyString(row?.value)
                if (label && value) {
                    target.statusRows.set(label, value)
                }
            }
        }
        return { initDone: false, statusDone: true }
    }
    return { initDone: false, statusDone: false }
}

function runClaudeStatusProbe(executable: string, env: NodeJS.ProcessEnv): Promise<ClaudeControlProbeResult> {
    const args = [
        '--print',
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
        '--verbose',
        '--setting-sources', 'user',
        '--strict-mcp-config',
        '--settings', JSON.stringify({ disableAllHooks: true })
    ]

    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, {
            cwd: homedir(),
            env: withBunRuntimeEnv(env, { allowBunBeBun: false }),
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: false,
            windowsHide: process.platform === 'win32'
        })

        const result: ClaudeControlProbeResult = {
            account: null,
            statusRows: new Map()
        }
        let initDone = false
        let statusDone = false
        let stdoutBuffer = ''
        let stderr = ''
        let settled = false

        const finish = (cb: () => void) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            if (child.pid) {
                void (async () => {
                    await killProcessByChildProcess(child, false).catch(() => false)
                    await killProcessByChildProcess(child, true).catch(() => false)
                })()
            }
            cb()
        }

        const timer = setTimeout(() => {
            finish(() => {
                if (initDone || statusDone) {
                    resolve(result)
                } else {
                    reject(new Error('Claude status probe timed out'))
                }
            })
        }, CLAUDE_PROBE_TIMEOUT_MS)

        child.stdout?.on('data', (chunk) => {
            stdoutBuffer += chunk.toString()
            let idx = stdoutBuffer.indexOf('\n')
            while (idx !== -1 && !settled) {
                const line = stdoutBuffer.slice(0, idx)
                stdoutBuffer = stdoutBuffer.slice(idx + 1)
                idx = stdoutBuffer.indexOf('\n')
                const step = parseClaudeQuotaControlLine(line, result)
                if (step.initDone) initDone = true
                if (step.statusDone) statusDone = true
                if (initDone && statusDone) {
                    finish(() => resolve(result))
                    return
                }
            }
        })
        child.stderr?.on('data', (chunk) => {
            stderr += chunk.toString()
        })
        child.on('error', (error) => {
            finish(() => reject(error))
        })
        child.on('close', (code) => {
            finish(() => {
                if (initDone || statusDone) {
                    resolve(result)
                } else {
                    reject(new Error(stderr.trim() || `Claude exited with code ${code ?? 'unknown'}`))
                }
            })
        })
        child.stdin?.on('error', () => { /* handled via close */ })
        child.stdin?.write(
            `${JSON.stringify({ type: 'control_request', request_id: CLAUDE_INIT_REQ_ID, request: { subtype: 'initialize' } })}\n`
            + `${JSON.stringify({ type: 'control_request', request_id: CLAUDE_STATUS_REQ_ID, request: { subtype: 'get_status' } })}\n`
        )
    })
}

function computeProbedClaudeAccountKey(params: {
    email: string | null
    accountUuid?: string | null
    baseUrl: string | null
    organization: string | null
}): string | null {
    if (params.email) return `acct:${params.email.toLowerCase()}`
    if (params.accountUuid) return `acct:${params.accountUuid.toLowerCase()}`
    if (params.baseUrl) return `url:${params.baseUrl.toLowerCase()}`
    if (params.organization) return `org:${params.organization.toLowerCase()}`
    return null
}

export function getActiveClaudeBuckets(
    env: NodeJS.ProcessEnv = process.env,
    allowedAccountKeys?: ReadonlySet<string>
): AgentQuotaBucket[] {
    const now = Date.now()
    const defaultSessionKey = resolveClaudeSessionAccountKey(env)
    const effectiveAllowed = allowedAccountKeys
        ?? (defaultSessionKey ? new Set([defaultSessionKey]) : new Set<string>())
    if (effectiveAllowed.size === 0) return []
    const byRateLimitType = new Map<string, LiveClaudeBucketRecord>()
    const persisted = readPersistedLiveQuotaState(env)

    const consider = (compKey: string, entry: LiveClaudeBucketRecord) => {
        if (!effectiveAllowed.has(entry.accountKey)) return
        if (entry.resetsAt && entry.resetsAt <= now) {
            liveClaudeBuckets.delete(compKey)
            return
        }
        const existing = byRateLimitType.get(entry.rateLimitType)
        if (!existing || entry.updatedAt >= existing.updatedAt) {
            byRateLimitType.set(entry.rateLimitType, entry)
        }
    }

    if (persisted.claudeBuckets) {
        for (const [compKey, entry] of Object.entries(persisted.claudeBuckets)) {
            consider(compKey, entry)
        }
    }
    for (const [compKey, entry] of liveClaudeBuckets.entries()) {
        consider(compKey, entry)
    }

    const buckets: AgentQuotaBucket[] = []
    for (const entry of byRateLimitType.values()) {
        const {
            updatedAt: _updatedAt,
            accountKey: _accountKey,
            rateLimitType: _rateLimitType,
            ...bucket
        } = entry
        buckets.push(bucket)
    }
    return buckets
}

let claudeStatusProbeOverrideForTests: ((executable: string, env: NodeJS.ProcessEnv) => Promise<ClaudeControlProbeResult>) | null = null

export function _setClaudeStatusProbeForTests(
    fn: ((executable: string, env: NodeJS.ProcessEnv) => Promise<ClaudeControlProbeResult>) | null
): void {
    claudeStatusProbeOverrideForTests = fn
}

export async function probeClaudeQuota(env: NodeJS.ProcessEnv = process.env): Promise<AgentQuotaAccount> {
    const updatedAt = Date.now()
    const availability = getAgentAvailability('claude', env)
    if (!availability.available) {
        return {
            agent: 'claude',
            available: false,
            status: 'unavailable',
            buckets: [],
            updatedAt
        }
    }

    try {
        const probeRunner = claudeStatusProbeOverrideForTests ?? runClaudeStatusProbe
        const executable = claudeStatusProbeOverrideForTests ? 'claude' : getDefaultClaudeCodePath(env)
        const probe = await probeRunner(executable, env)
        const rows = probe.statusRows
        const account = probe.account

        const loginRow = rows.get('Login')
        if (loginRow && loginRow.toLowerCase().startsWith('expired')) {
            return {
                agent: 'claude',
                available: true,
                status: 'unauthenticated',
                accountLabel: rows.get('Email') ?? null,
                buckets: [],
                note: loginRow,
                updatedAt
            }
        }

        const email = rows.get('Email') ?? asNonEmptyString(account?.email)
        const baseUrl = rows.get('Anthropic base URL')
            ?? rows.get('Gateway URL')
            ?? rows.get('Bedrock base URL')
            ?? rows.get('Vertex base URL')
            ?? asNonEmptyString(env.ANTHROPIC_BASE_URL)
        const loginMethod = rows.get('Login method')
            ?? asNonEmptyString(account?.subscriptionType)
        const authTokenSource = rows.get('Auth token')
            ?? rows.get('API key')
            ?? asNonEmptyString(account?.tokenSource)
        const apiProvider = rows.get('API provider')
            ?? asNonEmptyString(account?.apiProvider)
        const organization = rows.get('Organization')

        if (!email && !authTokenSource && !loginMethod && !baseUrl) {
            return {
                agent: 'claude',
                available: true,
                status: 'unauthenticated',
                buckets: [],
                note: 'Not signed in to Claude Code',
                updatedAt
            }
        }

        const probedAccountKey = computeProbedClaudeAccountKey({
            email: email ?? null,
            accountUuid: asNonEmptyString(account?.accountUuid),
            baseUrl: baseUrl ?? null,
            organization: organization ?? null
        })
        const allowedKeys = new Set<string>()
        if (probedAccountKey) {
            allowedKeys.add(probedAccountKey)
        }
        const envCredKey = resolveClaudeEnvCredentialKey(env)
        if (envCredKey) {
            allowedKeys.add(envCredKey)
        }
        if (!probedAccountKey && !envCredKey) {
            const configKey = readClaudeConfigAccountKey(env)
            if (configKey) {
                allowedKeys.add(configKey)
            }
        }

        const buckets = getActiveClaudeBuckets(env, allowedKeys)

        const isCustomProvider = Boolean(baseUrl) || (apiProvider !== null && apiProvider !== 'firstParty') || (!loginMethod && Boolean(authTokenSource))
        const accountLabel = email ?? baseUrl ?? organization ?? authTokenSource
        const planLabel = loginMethod
            ? loginMethod.replace(/\s+account$/i, '')
            : authTokenSource ?? apiProvider ?? null

        if (isCustomProvider && buckets.length === 0) {
            const noteParts: string[] = []
            if (baseUrl) noteParts.push(`Endpoint: ${baseUrl}`)
            if (authTokenSource) noteParts.push(`Auth: ${authTokenSource}`)
            return {
                agent: 'claude',
                available: true,
                status: 'custom_provider',
                accountLabel,
                planLabel,
                buckets: [],
                note: noteParts.join(' · ') || 'Custom provider endpoint (no fixed subscription window)',
                updatedAt
            }
        }

        return {
            agent: 'claude',
            available: true,
            status: 'ok',
            accountLabel,
            planLabel,
            buckets,
            note: buckets.length === 0 ? 'Quota utilization updates on the next Claude turn' : null,
            updatedAt
        }
    } catch (error) {
        return {
            agent: 'claude',
            available: true,
            status: 'error',
            buckets: getActiveClaudeBuckets(env),
            note: error instanceof Error ? error.message : 'Failed to query Claude status',
            updatedAt
        }
    }
}

export async function getAgentQuotasResponse(options?: {
    refresh?: boolean
    env?: NodeJS.ProcessEnv
    probeTimeoutMs?: number
}): Promise<AgentQuotasResponse> {
    const refresh = options?.refresh === true
    const env = options?.env ?? process.env
    const probeTimeoutMs = options?.probeTimeoutMs ?? DEFAULT_PROVIDER_PROBE_TIMEOUT_MS
    const now = Date.now()
    const latestLiveUpdateAt = getLatestLiveQuotaUpdateAt(env)

    if (
        !refresh
        && cachedResponse
        && cachedResponse.expiresAt > now
        && latestLiveUpdateAt <= cachedResponse.startedAt
    ) {
        return cachedResponse.response
    }

    if (!refresh && inflightPromise) {
        return await inflightPromise
    }

    const startedAt = Date.now()
    const promise = (async (): Promise<AgentQuotasResponse> => {
        const accounts = await Promise.all([
            probeCodexQuota(env, probeTimeoutMs),
            probeAgyQuota(env),
            probeClaudeQuota(env)
        ])
        const fetchedAt = Date.now()
        const response: AgentQuotasResponse = {
            accounts,
            fetchedAt
        }
        cachedResponse = {
            startedAt,
            expiresAt: fetchedAt + CACHE_TTL_MS,
            response
        }
        return response
    })().finally(() => {
        if (inflightPromise === promise) {
            inflightPromise = null
        }
    })

    inflightPromise = promise
    return await promise
}

export function _resetAgentQuotasCacheForTests(): void {
    cachedResponse = null
    inflightPromise = null
    liveClaudeBuckets.clear()
    liveAgyTierLabel = null
    claudeStatusProbeOverrideForTests = null
}
