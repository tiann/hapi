import type { NormalizedAgentContent, NormalizedMessage } from '@/chat/types'
import { isObject } from '@hapi/protocol'

const SUBAGENT_NOTIFICATION_PREFIX = '<subagent_notification>'

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

export function annotateCodexSidechains(messages: NormalizedMessage[]): NormalizedMessage[] {
    const toolNameByToolUseId = new Map<string, string>()
    let activeSpawnToolUseId: string | null = null
    let activeAgentId: string | null = null

    const result: NormalizedMessage[] = []

    for (const message of messages) {
        for (const toolCall of getToolCallBlocks(message)) {
            toolNameByToolUseId.set(toolCall.id, toolCall.name)
        }

        const spawn = extractSpawnAgentId(message, toolNameByToolUseId)
        if (spawn) {
            activeSpawnToolUseId = spawn.spawnToolUseId
            activeAgentId = spawn.agentId
            result.push({ ...message })
            continue
        }

        const waitTargets: string[] = activeAgentId !== null ? extractWaitTargets(message) : []
        if (activeSpawnToolUseId !== null && activeAgentId !== null && waitTargets.includes(activeAgentId)) {
            activeSpawnToolUseId = null
            activeAgentId = null
            result.push({ ...message })
            continue
        }

        if (activeSpawnToolUseId !== null && messageLooksLikeInlineChildConversation(message)) {
            result.push({
                ...message,
                isSidechain: true,
                sidechainKey: activeSpawnToolUseId
            })
            continue
        }

        result.push({ ...message })
    }

    return result
}
