import type {
    ClaudeContextDetails,
    ContextDetails,
    ContextUsageSnapshot,
    CodexContextDetails,
    Metadata
} from '@hapi/protocol'
import type { SkillMetadata, ThreadStartParams } from '@/codex/appServerTypes'
import type { McpServersConfig } from '@/codex/utils/buildHapiMcpBridge'

type JsonRecord = Record<string, unknown>

export interface CodexMcpServerInventory {
    name: string
    toolNames?: string[]
    status?: string
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

    const usage: ContextUsageSnapshot = {
        contextTokens: asTokenCount(record.contextTokens ?? record.context_tokens),
        cacheReadTokens: asTokenCount(
            record.cachedInputTokens
            ?? record.cached_input_tokens
            ?? record.cacheReadInputTokens
            ?? record.cache_read_input_tokens
        ),
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

function buildClaudeMcpTools(value: unknown): ClaudeContextDetails['mcpTools'] {
    if (!Array.isArray(value)) return undefined
    const tools = value.flatMap((item) => {
        const record = asRecord(item)
        const name = asString(record?.name ?? record?.tool_name ?? record?.toolName)
        if (!name) return []
        return [{
            name,
            serverName: asString(record?.server_name ?? record?.serverName ?? record?.server)
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
    updatedAt?: number
}): ContextDetails | null {
    const contextUsage = asRecord(args.contextUsage)
    const system = asRecord(args.system)
    const result = asRecord(args.result)
    const model = asString(contextUsage?.model) ?? asString(args.model) ?? asString(system?.model) ?? asString(result?.model)
    const contextWindow = asTokenCount(
        contextUsage?.raw_max_tokens
        ?? contextUsage?.rawMaxTokens
        ?? contextUsage?.context_window
        ?? contextUsage?.contextWindow
        ?? getClaudeModelUsageContextWindow(result, model)
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
    const mcpTools = buildClaudeMcpTools(contextUsage?.mcp_tools ?? contextUsage?.mcpTools)
    const systemTools = asStringList(system?.tools)
    const slashCommands = asStringList(system?.slash_commands)
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

function buildCodexUsage(value: unknown, fallbackContextTokens?: number): ContextUsageSnapshot | undefined {
    const usage = normalizeCodexUsageSnapshot(value)
    if (!usage) return undefined
    if (usage.contextTokens === undefined && fallbackContextTokens !== undefined) {
        return { ...usage, contextTokens: fallbackContextTokens }
    }
    return usage
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
    mcpServers?: McpServersConfig
    mcpServerInventory?: readonly CodexMcpServerInventory[]
    updatedAt?: number
}): ContextDetails {
    const info = asRecord(args.info)
    const last = asRecord(info?.last ?? info?.lastTokenUsage ?? info?.last_token_usage)
    const infoContextTokens = asTokenCount(info?.contextTokens ?? info?.context_tokens)
    const usage = buildCodexUsage(last ?? info, infoContextTokens)
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
    for (const [name, server] of Object.entries(args.mcpServers ?? {})) {
        const previous = mcpServerByName.get(name)
        mcpServerByName.set(name, {
            name,
            ...(server.tools
                ? { toolNames: Object.keys(server.tools) }
                : previous?.toolNames
                    ? { toolNames: previous.toolNames }
                    : {}),
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

    const merged: ContextDetails = {
        ...compactPrevious,
        ...compactNext,
        ...(compactPrevious.usage || compactNext.usage ? { usage: { ...compactPrevious.usage, ...compactNext.usage } } : {}),
        ...(compactPrevious.claude || compactNext.claude ? { claude: { ...compactPrevious.claude, ...compactNext.claude } } : {}),
        ...(compactPrevious.codex || compactNext.codex ? { codex: { ...compactPrevious.codex, ...compactNext.codex } } : {})
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
    updateMetadata?: (handler: (metadata: Metadata) => Metadata) => void
}

export function publishContextDetails(client: ContextDetailsClient, next: ContextDetails): void {
    if (!client.updateMetadata) return
    client.updateMetadata((metadata) => {
        const current = metadata.contextDetails
        const merged = mergeContextDetails(current, next)
        return merged === current
            ? metadata
            : {
                ...metadata,
                contextDetails: merged
            }
    })
}
