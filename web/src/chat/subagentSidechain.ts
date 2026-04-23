import type { NormalizedAgentContent, NormalizedMessage } from '@/chat/types'
import { isObject } from '@hapi/protocol'

const SUBAGENT_NOTIFICATION_PREFIX = '<subagent_notification>'
const CODEX_CONTROL_TOOL_NAMES = new Set(['CodexWaitAgent', 'CodexSendInput', 'CodexCloseAgent'])

function extractSubagentSidechainKey(meta: unknown): string | null {
    if (!isObject(meta)) return null

    const subagent = meta.subagent
    if (Array.isArray(subagent)) {
        for (const item of subagent) {
            if (item && typeof item === 'object' && typeof (item as { sidechainKey?: unknown }).sidechainKey === 'string') {
                const sidechainKey = (item as { sidechainKey: string }).sidechainKey
                if (sidechainKey.length > 0) return sidechainKey
            }
        }
        return null
    }

    if (subagent && typeof subagent === 'object' && typeof (subagent as { sidechainKey?: unknown }).sidechainKey === 'string') {
        const sidechainKey = (subagent as { sidechainKey: string }).sidechainKey
        return sidechainKey.length > 0 ? sidechainKey : null
    }

    return null
}

function getToolCallBlocks(message: NormalizedMessage): Extract<NormalizedAgentContent, { type: 'tool-call' }>[] {
    if (message.role !== 'agent') return []
    return message.content.filter((content): content is Extract<NormalizedAgentContent, { type: 'tool-call' }> => content.type === 'tool-call')
}

function getToolResultBlocks(message: NormalizedMessage): Extract<NormalizedAgentContent, { type: 'tool-result' }>[] {
    if (message.role !== 'agent') return []
    return message.content.filter((content): content is Extract<NormalizedAgentContent, { type: 'tool-result' }> => content.type === 'tool-result')
}

function extractSpawnAgentId(
    message: NormalizedMessage,
    toolNameByToolUseId: Map<string, string>
): { agentId: string; spawnToolUseId: string } | null {
    for (const result of getToolResultBlocks(message)) {
        const toolName = toolNameByToolUseId.get(result.tool_use_id)
        if (toolName !== 'CodexSpawnAgent') continue
        if (!isObject(result.content)) continue

        const agentId = typeof result.content.agent_id === 'string' ? result.content.agent_id : null
        if (!agentId || agentId.length === 0) continue

        return { agentId, spawnToolUseId: result.tool_use_id }
    }

    return null
}

function extractWaitTargets(message: NormalizedMessage): string[] {
    for (const toolCall of getToolCallBlocks(message)) {
        if (toolCall.name !== 'CodexWaitAgent') continue
        if (!isObject(toolCall.input) || !Array.isArray(toolCall.input.targets)) continue

        return toolCall.input.targets.filter((target): target is string => typeof target === 'string' && target.length > 0)
    }

    return []
}

function messageContainsCodexControlToolResult(
    message: NormalizedMessage,
    toolNameByToolUseId: Map<string, string>
): boolean {
    return getToolResultBlocks(message).some((toolResult) => {
        const toolName = toolNameByToolUseId.get(toolResult.tool_use_id)
        return typeof toolName === 'string' && CODEX_CONTROL_TOOL_NAMES.has(toolName)
    })
}

function messageLooksLikeInlineChildConversation(message: NormalizedMessage): boolean {
    if (message.role === 'user') {
        return message.content.type === 'text' && !message.content.text.trimStart().startsWith(SUBAGENT_NOTIFICATION_PREFIX)
    }

    if (message.role !== 'agent') return false
    if (message.content.length === 0) return false

    let sawNestableContent = false
    for (const block of message.content) {
        if (block.type === 'summary' || block.type === 'sidechain') return false
        if (block.type === 'text') {
            if (block.text.trimStart().startsWith(SUBAGENT_NOTIFICATION_PREFIX)) return false
            sawNestableContent = true
            continue
        }
        if (block.type === 'reasoning' || block.type === 'tool-call' || block.type === 'tool-result') {
            sawNestableContent = true
            continue
        }
        return false
    }

    return sawNestableContent
}

function messageContainsSpawnToolCall(message: NormalizedMessage): boolean {
    return getToolCallBlocks(message).some((toolCall) => toolCall.name === 'CodexSpawnAgent')
}

function removeActiveAgents(activeAgentIds: string[], targets: string[]): string[] {
    if (targets.length === 0) return activeAgentIds
    const closed = new Set(targets)
    return activeAgentIds.filter((agentId) => !closed.has(agentId))
}

function annotateExplicitSidechain(message: NormalizedMessage): NormalizedMessage | null {
    const sidechainKey = message.sidechainKey ?? extractSubagentSidechainKey(message.meta)
    if (!sidechainKey) return null
    return {
        ...message,
        isSidechain: true,
        sidechainKey
    }
}

export function annotateSubagentSidechains<T extends NormalizedMessage>(messages: T[]): T[] {
    const toolNameByToolUseId = new Map<string, string>()
    for (const message of messages) {
        for (const toolCall of getToolCallBlocks(message)) {
            toolNameByToolUseId.set(toolCall.id, toolCall.name)
        }
    }

    const validSpawnToolUseIds = new Set<string>()
    for (const message of messages) {
        for (const result of getToolResultBlocks(message)) {
            const toolName = toolNameByToolUseId.get(result.tool_use_id)
            if (toolName !== 'CodexSpawnAgent') continue
            if (!isObject(result.content)) continue
            const agentId = typeof result.content.agent_id === 'string' ? result.content.agent_id : null
            if (agentId && agentId.length > 0) {
                validSpawnToolUseIds.add(result.tool_use_id)
            }
        }
    }

    const agentIdToSpawnToolUseId = new Map<string, string>()
    let activeAgentIds: string[] = []
    let pendingSpawnToolUseId: string | null = null

    const result: T[] = []

    for (const message of messages) {
        const explicit = annotateExplicitSidechain(message)
        if (explicit) {
            result.push(explicit as T)
            continue
        }

        let hasCodexSpawnToolCall = false
        for (const toolCall of getToolCallBlocks(message)) {
            if (toolCall.name === 'CodexSpawnAgent' && validSpawnToolUseIds.has(toolCall.id)) {
                pendingSpawnToolUseId = toolCall.id
                hasCodexSpawnToolCall = true
            }
        }

        const spawn = extractSpawnAgentId(message, toolNameByToolUseId)
        if (spawn) {
            pendingSpawnToolUseId = null
            const alreadyKnownSpawn = agentIdToSpawnToolUseId.get(spawn.agentId) === spawn.spawnToolUseId
            agentIdToSpawnToolUseId.set(spawn.agentId, spawn.spawnToolUseId)
            if (!alreadyKnownSpawn) {
                activeAgentIds = removeActiveAgents(activeAgentIds, [spawn.agentId])
                activeAgentIds.push(spawn.agentId)
            }
            result.push({ ...message })
            continue
        }

        const waitTargets = extractWaitTargets(message)
        if (waitTargets.length > 0) {
            activeAgentIds = removeActiveAgents(activeAgentIds, waitTargets)
            result.push({ ...message })
            continue
        }

        if (messageContainsCodexControlToolResult(message, toolNameByToolUseId)) {
            result.push({ ...message })
            continue
        }

        const activeAgentId = activeAgentIds.length === 1 ? activeAgentIds[0] : null
        let activeSpawnToolUseId = activeAgentId ? agentIdToSpawnToolUseId.get(activeAgentId) ?? null : null
        if (!activeSpawnToolUseId && pendingSpawnToolUseId && !hasCodexSpawnToolCall) {
            activeSpawnToolUseId = pendingSpawnToolUseId
        }
        if (
            activeSpawnToolUseId !== null
            && !messageContainsSpawnToolCall(message)
            && messageLooksLikeInlineChildConversation(message)
        ) {
            result.push({
                ...message,
                isSidechain: true,
                sidechainKey: activeSpawnToolUseId
            } as T)
            continue
        }

        result.push({ ...message })
    }

    return result
}
