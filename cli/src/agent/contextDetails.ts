import type {
    ClaudeContextDetails,
    ContextDetails,
    ContextUsageSnapshot,
    CodexContextDetails,
    Metadata
} from '@hapi/protocol'
import type { SkillMetadata, ThreadStartParams } from '@/codex/appServerTypes'

type JsonRecord = Record<string, unknown>

export interface CodexMcpServerInventory {
    name: string
    toolNames?: string[]
    status?: string
    /** Explicit config enablement, used only to resolve saved status fallback. */
    enabled?: boolean
}

function asRecord(value: unknown): JsonRecord | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as JsonRecord
        : null
}

function asString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function asTokenCount(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
    return Math.round(value)
}

function asStringList(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined
    const values = value
        .map(asString)
        .filter((value): value is string => value !== undefined)
    return values
}

function normalizeUsageSnapshot(value: unknown): ContextUsageSnapshot | undefined {
    const record = asRecord(value)
    if (!record) return undefined

    const cacheReadTokens = asTokenCount(
        record.cachedInputTokens
        ?? record.cached_input_tokens
        ?? record.cacheReadInputTokens
        ?? record.cache_read_input_tokens
    )
    const inputTokens = asTokenCount(record.inputTokens ?? record.input_tokens)
    const cacheCreationTokens = asTokenCount(
        record.cacheCreationInputTokens
        ?? record.cache_creation_input_tokens
    ) ?? 0
    const contextTokens = asTokenCount(record.contextTokens ?? record.context_tokens)
        ?? (inputTokens === undefined
            ? undefined
            : inputTokens + cacheCreationTokens + (cacheReadTokens ?? 0))
    const usage: ContextUsageSnapshot = {
        contextTokens,
        cacheReadTokens,
    }

    const hasValue = Object.values(usage).some((value) => value !== undefined)
    return hasValue ? usage : undefined
}

function normalizeCodexUsageSnapshot(value: unknown): ContextUsageSnapshot | undefined {
    const record = asRecord(value)
    if (!record) return undefined
    return normalizeUsageSnapshot({
        contextTokens: record.contextTokens
            ?? record.context_tokens
            ?? record.inputTokens
            ?? record.input_tokens,
        cachedInputTokens: record.cachedInputTokens ?? record.cached_input_tokens,
        cacheReadInputTokens: record.cacheReadInputTokens ?? record.cache_read_input_tokens
    })
}

function getClaudeModelUsageContextWindow(result: JsonRecord | null, model?: string): number | undefined {
    const modelUsage = asRecord(result?.modelUsage ?? result?.model_usage)
    if (!modelUsage) return undefined
    const entries = Object.entries(modelUsage)
    const selectedUsage = model
        ? asRecord(modelUsage[model])
        : entries.length === 1
            ? asRecord(entries[0][1])
            : null
    return asTokenCount(selectedUsage?.contextWindow ?? selectedUsage?.context_window)
}

function normalizeClaudeCommandName(value: string): string {
    return value.replace(/^\//, '')
}

function filterClaudeSlashCommands(
    commands: readonly string[] | undefined,
    skills: ClaudeContextDetails['skills']
): string[] | undefined {
    if (!commands || !skills) return commands as string[] | undefined
    const skillNames = new Set(skills.map(skill => normalizeClaudeCommandName(skill.name)))
    return commands.filter(command => !skillNames.has(normalizeClaudeCommandName(command)))
}

function buildClaudeSkills(value: unknown): ClaudeContextDetails['skills'] {
    if (!Array.isArray(value)) return undefined
    const skills = value.flatMap((item) => {
        const record = asRecord(item)
        const name = typeof item === 'string' ? asString(item) : asString(record?.name)
        if (!name) return []
        return [{ name }]
    })
    return skills
}

export function sameClaudeModelID(left: string, right: string): boolean {
    return left.replace(/\[1m\]$/, '') === right.replace(/\[1m\]$/, '')
}
function mcpServerNameFromTool(name: string): string | undefined {
    if (!name.startsWith('mcp__')) return undefined
    const remainder = name.slice('mcp__'.length)
    const separator = remainder.indexOf('__')
    return separator > 0 ? remainder.slice(0, separator) : undefined
}

function buildClaudeMcpTools(value: unknown): ClaudeContextDetails['mcpTools'] {
    if (!Array.isArray(value)) return undefined
    const tools = value.flatMap((item) => {
        const record = asRecord(item)
        const name = typeof item === 'string' ? asString(item) : asString(record?.name ?? record?.tool_name ?? record?.toolName)
        if (!name) return []
        return [{
            name,
            serverName: asString(record?.server_name ?? record?.serverName ?? record?.server) ?? mcpServerNameFromTool(name)
        }]
    })
    return tools
}

export function buildClaudeContextDetails(args: {
    contextUsage?: unknown
    system?: unknown
    result?: unknown
    messageUsage?: unknown
    model?: string | null
    effectiveContextWindow?: number
    updatedAt?: number
}): ContextDetails | null {
    const contextUsage = asRecord(args.contextUsage)
    const system = asRecord(args.system)
    const result = asRecord(args.result)
    const model = asString(contextUsage?.model) ?? asString(args.model) ?? asString(system?.model) ?? asString(result?.model)
    const rawMessageUsage = asRecord(args.messageUsage)
    const contextWindow = asTokenCount(
        args.effectiveContextWindow
        ?? getClaudeModelUsageContextWindow(result, model)
        ?? contextUsage?.raw_max_tokens
        ?? contextUsage?.rawMaxTokens
        ?? contextUsage?.context_window
        ?? contextUsage?.contextWindow
        ?? rawMessageUsage?.context_window
        ?? rawMessageUsage?.contextWindow
    )
    const messageUsage = normalizeUsageSnapshot(args.messageUsage ?? result?.usage)
    const contextTokens = asTokenCount(
        contextUsage?.total_tokens
        ?? contextUsage?.totalTokens
        ?? contextUsage?.context_tokens
        ?? contextUsage?.contextTokens
    )
    const usage: ContextUsageSnapshot = {
        ...messageUsage,
        ...(contextTokens !== undefined ? { contextTokens } : {})
    }
    const hasUsage = Object.values(usage).some((value) => value !== undefined)

    const skills = buildClaudeSkills(contextUsage?.skills) ?? buildClaudeSkills(system?.skills)
    const systemToolNames = asStringList(system?.tools)
    const systemMcpToolNames = systemToolNames?.filter(name => name.startsWith('mcp__'))
    const mcpTools = buildClaudeMcpTools(contextUsage?.mcp_tools ?? contextUsage?.mcpTools)
        ?? (systemToolNames ? buildClaudeMcpTools(systemMcpToolNames) : undefined)
    const systemTools = systemToolNames?.filter(name => !name.startsWith('mcp__'))
    const slashCommands = filterClaudeSlashCommands(asStringList(system?.slash_commands), skills)
    const claude: ClaudeContextDetails = {
        ...(skills ? { skills } : {}),
        ...(mcpTools ? { mcpTools } : {}),
        ...(systemTools ? { systemTools } : {}),
        ...(slashCommands ? { slashCommands } : {})
    }
    const hasClaudeDetails = Object.keys(claude).length > 0

    if (!model && contextWindow === undefined && !hasUsage && !hasClaudeDetails) return null

    return {
        version: 1,
        updatedAt: args.updatedAt ?? Date.now(),
        provider: 'claude',
        ...(model ? { model } : {}),
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(hasUsage ? { usage } : {}),
        ...(hasClaudeDetails ? { claude } : {})
    }
}

function buildCodexUsage(value: unknown, explicitContextTokens?: number): ContextUsageSnapshot | undefined {
    const usage = normalizeCodexUsageSnapshot(value)
    if (!usage) {
        return explicitContextTokens === undefined
            ? undefined
            : { contextTokens: explicitContextTokens }
    }
    return explicitContextTokens === undefined
        ? usage
        : { ...usage, contextTokens: explicitContextTokens }
}

function getCodexThreadRecord(response: unknown): JsonRecord | null {
    return asRecord(asRecord(response)?.thread)
}

export function buildCodexContextDetails(args: {
    info?: unknown
    model?: string | null
    threadId?: string | null
    threadResponse?: unknown
    threadParams?: ThreadStartParams
    slashCommands?: readonly string[]
    skills?: readonly (Pick<SkillMetadata, 'name' | 'enabled'> | SkillMetadata)[]
    mcpServers?: Record<string, unknown>
    mcpServerInventory?: readonly CodexMcpServerInventory[]
    updatedAt?: number
}): ContextDetails {
    const info = asRecord(args.info)
    const usageRecord =
        asRecord(info?.last ?? info?.lastTokenUsage ?? info?.last_token_usage)
        ?? asRecord(info?.total ?? info?.totalTokenUsage ?? info?.total_token_usage)
        ?? info
    const infoContextTokens = asTokenCount(info?.contextTokens ?? info?.context_tokens)
    const usage = buildCodexUsage(usageRecord, infoContextTokens)
    const response = asRecord(args.threadResponse)
    const thread = getCodexThreadRecord(args.threadResponse)
    const contextWindow = asTokenCount(
        info?.modelContextWindow
        ?? info?.model_context_window
        ?? response?.modelContextWindow
        ?? response?.model_context_window
        ?? thread?.modelContextWindow
        ?? thread?.model_context_window
    )
    const model = asString(args.model) ?? asString(response?.model) ?? asString(thread?.model)
    const slashCommands = args.slashCommands === undefined
        ? undefined
        : Array.from(new Set(args.slashCommands
            .filter((command) => command.trim())
            .map((command) => command.trim())))
    const skills = args.skills === undefined
        ? undefined
        : args.skills
            .filter((skill) => skill.enabled)
            .map((skill) => ({
                name: skill.name
            }))
    const mcpServerByName = new Map<string, CodexMcpServerInventory>()
    for (const server of args.mcpServerInventory ?? []) {
        const name = server.name.trim()
        if (!name) continue
        mcpServerByName.set(name, {
            name,
            ...(server.toolNames ? { toolNames: [...server.toolNames] } : {}),
            ...(server.status ? { status: server.status } : {})
        })
    }
    for (const name of Object.keys(args.mcpServers ?? {})) {
        const previous = mcpServerByName.get(name)
        mcpServerByName.set(name, {
            name,
            ...(previous?.toolNames !== undefined ? { toolNames: [...previous.toolNames] } : {}),
            ...(previous?.status ? { status: previous.status } : {})
        })
    }
    const mcpServers = args.mcpServers !== undefined || args.mcpServerInventory !== undefined
        ? Array.from(mcpServerByName.values())
        : undefined
    const codex: CodexContextDetails = {
        ...(slashCommands !== undefined ? { slashCommands } : {}),
        ...(skills !== undefined ? { skills } : {}),
        ...(mcpServers !== undefined ? { mcpServers } : {})
    }

    return {
        version: 1,
        updatedAt: args.updatedAt ?? Date.now(),
        provider: 'codex',
        ...(model ? { model } : {}),
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(usage ? { usage } : {}),
        ...(Object.keys(codex).length > 0 ? { codex } : {})
    }
}

function withoutUpdatedAt(details: ContextDetails): Omit<ContextDetails, 'updatedAt'> {
    const { updatedAt: _updatedAt, ...rest } = details
    return rest
}

function compactContextDetails(details: ContextDetails): ContextDetails {
    const claude = details.claude
        ? {
            ...(claudeSkills(details.claude.skills) ? { skills: claudeSkills(details.claude.skills) } : {}),
            ...(details.claude.mcpTools
                ? {
                    mcpTools: details.claude.mcpTools.map((tool) => ({
                        name: tool.name,
                        ...(tool.serverName ? { serverName: tool.serverName } : {})
                    }))
                }
                : {}),
            ...(details.claude.systemTools ? { systemTools: [...details.claude.systemTools] } : {}),
            ...(details.claude.slashCommands ? { slashCommands: [...details.claude.slashCommands] } : {})
        }
        : undefined
    const codex = details.codex
        ? {
            ...(details.codex.slashCommands ? { slashCommands: [...details.codex.slashCommands] } : {}),
            ...(details.codex.skills
                ? { skills: details.codex.skills.map((skill) => ({ name: skill.name })) }
                : {}),
            ...(details.codex.mcpServers
                ? {
                    mcpServers: details.codex.mcpServers.map((server) => ({
                        name: server.name,
                        ...(server.toolNames ? { toolNames: [...server.toolNames] } : {}),
                        ...(server.status ? { status: server.status } : {})
                    }))
                }
                : {})
        }
        : undefined

    return {
        version: 1,
        updatedAt: details.updatedAt,
        provider: details.provider,
        ...(details.model ? { model: details.model } : {}),
        ...(details.contextWindow !== undefined ? { contextWindow: details.contextWindow } : {}),
        ...(details.usage ? { usage: { ...details.usage } } : {}),
        ...(claude && Object.keys(claude).length > 0 ? { claude } : {}),
        ...(codex && Object.keys(codex).length > 0 ? { codex } : {})
    }
}

function claudeSkills(value: ClaudeContextDetails['skills']): ClaudeContextDetails['skills'] {
    return value?.map((skill) => ({ name: skill.name }))
}

export function mergeContextDetails(
    previous: ContextDetails | null | undefined,
    next: ContextDetails
): ContextDetails {
    const compactPrevious = previous ? compactContextDetails(previous) : null
    const compactNext = compactContextDetails(next)
    if (!previous || !compactPrevious || compactPrevious.provider !== compactNext.provider) return compactNext

    const modelChanged = compactPrevious.model !== undefined
        && compactNext.model !== undefined
        && !sameClaudeModelID(compactPrevious.model, compactNext.model)
    // Model, window, and usage belong to one sample. Never pair a newly
    // reported model/window with the previous model's saved token count.
    const previousForMerge: ContextDetails = modelChanged
        ? (({ contextWindow: _contextWindow, usage: _usage, ...rest }) => rest)(compactPrevious)
        : compactPrevious
    const claude = previousForMerge.claude || compactNext.claude
        ? { ...previousForMerge.claude, ...compactNext.claude }
        : undefined
    if (claude?.slashCommands && claude.skills) {
        claude.slashCommands = filterClaudeSlashCommands(claude.slashCommands, claude.skills)
    }
    const merged: ContextDetails = {
        ...previousForMerge,
        ...compactNext,
        ...(previousForMerge.usage || compactNext.usage ? {
            usage: compactNext.usage?.contextTokens !== undefined
                ? compactNext.usage
                : { ...previousForMerge.usage, ...compactNext.usage }
        } : {}),
        ...(claude ? { claude } : {}),
        ...(previousForMerge.codex || compactNext.codex ? { codex: { ...previousForMerge.codex, ...compactNext.codex } } : {})
    }
    const unchanged = JSON.stringify(withoutUpdatedAt(compactPrevious)) === JSON.stringify(withoutUpdatedAt(merged))
    const previousWasCompact = JSON.stringify(withoutUpdatedAt(previous)) === JSON.stringify(withoutUpdatedAt(compactPrevious))
    return unchanged && previousWasCompact
        ? previous
        : unchanged
            ? compactPrevious
        : merged
}

export interface ContextDetailsClient {
    getMetadata?: () => Readonly<Metadata> | null
    updateMetadata?: (handler: (metadata: Metadata) => Metadata, options?: { skipUnchanged?: boolean }) => void
}

export interface PublishContextDetailsOptions {
    /** Result totals cover the whole conversation; keep the latest actual usage snapshot. */
    preserveUsageSnapshot?: boolean
    /** Legacy composer fields issued in the same CAS write as the startup inventory. */
    claudeStartupCatalog?: Pick<Metadata, 'tools' | 'slashCommands'>
    /** An authoritative preset/window change invalidates usage from the old sample. */
    clearUsageOnWindowChange?: boolean
    /** The launch or preset changed, even if the numeric window stayed the same. */
    clearUsageSample?: boolean
    /** The selected preset changed, invalidating both usage and its window. */
    clearContextSample?: boolean
}

// Per-client, not persisted: saved inventory from a prior launch is not proof
// that this CLI has already observed a live catalog. Empty lists do count.
const observedClaudeInventory = new WeakMap<ContextDetailsClient, Set<keyof ClaudeContextDetails>>()

function equalStrings(previous: readonly string[] | undefined, next: readonly string[]): boolean {
    return previous?.length === next.length && previous.every((value, index) => value === next[index])
}

export function publishContextDetails(
    client: ContextDetailsClient,
    next: ContextDetails,
    options: PublishContextDetailsOptions = {}
): void {
    if (!client.updateMetadata) return
    const catalog = options.claudeStartupCatalog
    let candidate: ContextDetails | null = next
    if (next.provider === 'claude' && next.claude) {
        const observed = observedClaudeInventory.get(client) ?? new Set<keyof ClaudeContextDetails>()
        if (catalog) {
            const claude = { ...next.claude }
            for (const key of observed) delete claude[key]
            candidate = Object.keys(claude).length ? { ...next, claude } : null
        } else {
            for (const key of Object.keys(next.claude) as Array<keyof ClaudeContextDetails>) {
                if (next.claude[key] !== undefined) observed.add(key)
            }
            observedClaudeInventory.set(client, observed)
        }
    }
    client.updateMetadata((metadata) => {
        const current = metadata.contextDetails
        let incoming = candidate
        if (candidate && options.preserveUsageSnapshot) {
            const savedUsage = current?.provider === 'claude' && current.model && candidate.model
                && sameClaudeModelID(current.model, candidate.model) ? current.usage : undefined
            incoming = {
                ...candidate,
                // Result totals are cumulative conversation counters, never a
                // current context sample. Preserve only the actual saved fields.
                usage: savedUsage ? {
                    ...(savedUsage.contextTokens !== undefined ? { contextTokens: savedUsage.contextTokens } : {}),
                    ...(savedUsage.cacheReadTokens !== undefined ? { cacheReadTokens: savedUsage.cacheReadTokens } : {})
                } : undefined
            }
        }
        const clearUsage = Boolean((options.clearUsageSample || options.clearContextSample || (options.clearUsageOnWindowChange
            && current?.contextWindow !== undefined && candidate?.contextWindow !== undefined
            && current.contextWindow !== candidate.contextWindow)) && current?.provider === 'claude'
            && candidate?.provider === 'claude')
        const previous = clearUsage && current
            ? { ...current, usage: undefined, ...(options.clearContextSample ? { contextWindow: undefined } : {}) }
            : current
        const merged = incoming ? mergeContextDetails(previous, incoming) : previous
        const patch: Pick<Metadata, 'tools' | 'slashCommands'> = {}
        if (catalog?.tools !== undefined && !equalStrings(metadata.tools, catalog.tools)) patch.tools = catalog.tools
        if (catalog?.slashCommands !== undefined && !equalStrings(metadata.slashCommands, catalog.slashCommands)) {
            patch.slashCommands = catalog.slashCommands
        }
        if (merged === current && Object.keys(patch).length === 0) return metadata
        return { ...metadata, ...patch, contextDetails: merged }
    }, { skipUnchanged: true })
}
