import type { AgentState } from '@/types/api'
import type { ChatBlock, NormalizedMessage, ToolCallBlock, UsageData } from '@/chat/types'
import { applyCodexLifecycleAggregation } from '@/chat/codexLifecycle'
import { annotateSubagentSidechains } from '@/chat/subagentSidechain'
import { traceMessages, type TracedMessage } from '@/chat/tracer'
import { dedupeAgentEvents, foldApiErrorEvents } from '@/chat/reducerEvents'
import { collectTitleChanges, collectToolIdsFromMessages, ensureToolBlock, getPermissions } from '@/chat/reducerTools'
import { reduceTimeline } from '@/chat/reducerTimeline'
import { isObject } from '@hapi/protocol'

// Calculate context size from usage data
function calculateContextSize(usage: UsageData): number {
    return (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0) + usage.input_tokens
}

function groupMessagesBySidechain(messages: TracedMessage[]): { groups: Map<string, TracedMessage[]>; root: TracedMessage[] } {
    const groups = new Map<string, TracedMessage[]>()
    const root: TracedMessage[] = []

    for (const msg of messages) {
        const groupId = msg.sidechainId ?? msg.sidechainKey
        if (groupId) {
            const existing = groups.get(groupId) ?? []
            existing.push(msg)
            groups.set(groupId, existing)
            continue
        }

        root.push(msg)
    }

    return { groups, root }
}

function attachCodexSpawnChildren(
    blocks: ChatBlock[],
    groups: Map<string, TracedMessage[]>,
    consumedGroupIds: Set<string>,
    reduceGroup: (groupId: string) => ChatBlock[]
): void {
    for (const block of blocks) {
        if (block.kind !== 'tool-call') continue

        if (block.tool.name === 'CodexSpawnAgent' && groups.has(block.tool.id) && !consumedGroupIds.has(block.tool.id)) {
            consumedGroupIds.add(block.tool.id)
            block.children = reduceGroup(block.tool.id)
        }

        if (block.children.length > 0) {
            attachCodexSpawnChildren(block.children, groups, consumedGroupIds, reduceGroup)
        }
    }
}

function appendUnconsumedSidechainGroups(
    blocks: ChatBlock[],
    groups: Map<string, TracedMessage[]>,
    consumedGroupIds: Set<string>,
    reduceGroup: (groupId: string) => ChatBlock[]
): void {
    const preservedBlocks: ChatBlock[] = []
    for (const [groupId, sidechain] of groups) {
        if (consumedGroupIds.has(groupId) || sidechain.length === 0) {
            continue
        }

        preservedBlocks.push(...reduceGroup(groupId))
    }

    if (preservedBlocks.length === 0) return

    const merged = [...blocks, ...preservedBlocks].sort((a, b) => {
        if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
        return 0
    })

    blocks.splice(0, blocks.length, ...merged)
}

function extractSpawnAgentId(block: ToolCallBlock): string | null {
    const result = isObject(block.tool.result) ? block.tool.result : null
    return result && typeof result.agent_id === 'string' && result.agent_id.length > 0
        ? result.agent_id
        : null
}

function reattachWaitBackfilledChildReplies(blocks: ChatBlock[]): void {
    const spawnByAgentId = new Map<string, ToolCallBlock>()

    for (const block of blocks) {
        if (block.kind !== 'tool-call' || block.tool.name !== 'CodexSpawnAgent') continue
        const agentId = extractSpawnAgentId(block)
        if (agentId) {
            spawnByAgentId.set(agentId, block)
        }
    }

    for (const block of [...blocks]) {
        if (block.kind !== 'tool-call' || block.tool.name !== 'CodexWaitAgent') continue
        const result = isObject(block.tool.result) ? block.tool.result : null
        const statuses = result && isObject(result.statuses) ? result.statuses : null
        if (!statuses) continue

        for (const [agentId, rawState] of Object.entries(statuses)) {
            const spawn = spawnByAgentId.get(agentId)
            const state = isObject(rawState) ? rawState : null
            const message = state && typeof state.message === 'string' && state.message.trim().length > 0
                ? state.message.trim()
                : null
            if (!spawn || !message) continue

            const alreadyNested = spawn.children.some(
                (child) => child.kind === 'agent-text' && child.text.trim() === message
            )
            if (alreadyNested) continue

            const strayIndex = blocks.findIndex(
                (candidate) => candidate.kind === 'agent-text' && candidate.text.trim() === message
            )
            if (strayIndex === -1) continue

            const [stray] = blocks.splice(strayIndex, 1)
            spawn.children.push(stray)
        }
    }
}

export type LatestUsage = {
    inputTokens: number
    outputTokens: number
    cacheCreation: number
    cacheRead: number
    contextSize: number
    timestamp: number
}

export function reduceChatBlocks(
    normalized: NormalizedMessage[],
    agentState: AgentState | null | undefined
): { blocks: ChatBlock[]; hasReadyEvent: boolean; latestUsage: LatestUsage | null } {
    const permissionsById = getPermissions(agentState)
    const toolIdsInMessages = collectToolIdsFromMessages(normalized)
    const titleChangesByToolUseId = collectTitleChanges(normalized)

    const traced = traceMessages(normalized)
    const annotated = annotateSubagentSidechains(traced)
    const { groups, root } = groupMessagesBySidechain(annotated)

    const consumedGroupIds = new Set<string>()
    const emittedTitleChangeToolUseIds = new Set<string>()
    const reducerContext = { permissionsById, groups, consumedGroupIds, titleChangesByToolUseId, emittedTitleChangeToolUseIds }
    const rootResult = reduceTimeline(root, reducerContext)
    let hasReadyEvent = rootResult.hasReadyEvent

    const reduceGroup = (groupId: string): ChatBlock[] => {
        const sidechain = groups.get(groupId) ?? []
        const child = reduceTimeline(sidechain, reducerContext, { renderSidechainPromptAsUserText: true })
        hasReadyEvent = hasReadyEvent || child.hasReadyEvent
        return child.blocks
    }

    attachCodexSpawnChildren(rootResult.blocks, groups, consumedGroupIds, reduceGroup)
    reattachWaitBackfilledChildReplies(rootResult.blocks)
    appendUnconsumedSidechainGroups(rootResult.blocks, groups, consumedGroupIds, reduceGroup)

    // Only create permission-only tool cards when there is no tool call/result in the transcript.
    // Also skip if the permission is older than the oldest message in the current view,
    // to avoid mixing old tool cards with newer messages when paginating.
    const oldestMessageTime = normalized.length > 0
        ? Math.min(...normalized.map(m => m.createdAt))
        : null

    for (const [id, entry] of permissionsById) {
        if (toolIdsInMessages.has(id)) continue
        if (rootResult.toolBlocksById.has(id)) continue

        const createdAt = entry.permission.createdAt ?? Date.now()

        // Skip permissions that are older than the oldest message in the current view.
        // These will be shown when the user loads older messages.
        if (oldestMessageTime !== null && createdAt < oldestMessageTime) {
            continue
        }

        const block = ensureToolBlock(rootResult.blocks, rootResult.toolBlocksById, id, {
            createdAt,
            localId: null,
            name: entry.toolName,
            input: entry.input,
            description: null,
            permission: entry.permission
        })

        if (entry.permission.status === 'approved') {
            block.tool.state = 'completed'
            block.tool.completedAt = entry.permission.completedAt ?? createdAt
            if (block.tool.result === undefined) {
                block.tool.result = 'Approved'
            }
        } else if (entry.permission.status === 'denied' || entry.permission.status === 'canceled') {
            block.tool.state = 'error'
            block.tool.completedAt = entry.permission.completedAt ?? createdAt
            if (block.tool.result === undefined && entry.permission.reason) {
                block.tool.result = { error: entry.permission.reason }
            }
        }
    }

    // Calculate latest usage from messages (find the most recent message with usage data)
    let latestUsage: LatestUsage | null = null
    for (let i = normalized.length - 1; i >= 0; i--) {
        const msg = normalized[i]
        if (msg.usage) {
            latestUsage = {
                inputTokens: msg.usage.input_tokens,
                outputTokens: msg.usage.output_tokens,
                cacheCreation: msg.usage.cache_creation_input_tokens ?? 0,
                cacheRead: msg.usage.cache_read_input_tokens ?? 0,
                contextSize: calculateContextSize(msg.usage),
                timestamp: msg.createdAt
            }
            break
        }
    }

    const mergedBlocks = applyCodexLifecycleAggregation(dedupeAgentEvents(foldApiErrorEvents(rootResult.blocks)))

    return { blocks: mergedBlocks, hasReadyEvent, latestUsage }
}
