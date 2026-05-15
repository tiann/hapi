import type { AgentReasoningBlock, AgentTextBlock, ChatBlock, CliOutputBlock, ToolCallBlock, ToolPermission } from '@/chat/types'
import type { TracedMessage } from '@/chat/tracer'
import { createCliOutputBlock, isCliOutputText, mergeCliOutputBlocks } from '@/chat/reducerCliOutput'
import { parseMessageAsEvent } from '@/chat/reducerEvents'
import { collectTitleChanges, ensureToolBlock, extractTitleFromChangeTitleInput, isChangeTitleToolName, type PermissionEntry } from '@/chat/reducerTools'
import { isSubagentToolName } from '@/chat/subagentTool'
import { asString, isObject } from '@hapi/protocol'

function getEventString(event: Record<string, unknown>, key: string): string | null {
    return asString(event[key])
}

function getEventNumber(event: Record<string, unknown>, key: string): number | null {
    const value = event[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function getAgentRunStartedAt(event: Record<string, unknown>): number | null {
    return getEventNumber(event, 'startedAt') ?? getEventNumber(event, 'started_at')
}

function getAgentRunCompletedAt(event: Record<string, unknown>): number | null {
    return getEventNumber(event, 'completedAt') ?? getEventNumber(event, 'completed_at')
}

function setEarliestStartedAt(block: ToolCallBlock, startedAt: number | null): void {
    if (startedAt === null) return
    block.tool.startedAt = block.tool.startedAt === null
        ? startedAt
        : Math.min(block.tool.startedAt, startedAt)
}

function getAgentRunCardId(event: Record<string, unknown>, fallback: string): string {
    return getEventString(event, 'cardId') ?? getEventString(event, 'card_id') ?? fallback
}

function isFallbackAgentRunCardId(cardId: string, agentId: string | null): boolean {
    return agentId !== null && cardId === `codex-agent:${agentId}`
}

function mapAgentRunStatusToToolState(status: string | null): ToolCallBlock['tool']['state'] {
    if (status === 'completed') return 'completed'
    if (
        status === 'failed'
        || status === 'error'
        || status === 'canceled'
        || status === 'cancelled'
        || status === 'notFound'
        || status === 'not_found'
    ) return 'error'
    if (status === 'pending') return 'pending'
    return 'running'
}

function isTerminalAgentRunState(state: ToolCallBlock['tool']['state']): boolean {
    return state === 'completed' || state === 'error'
}

function isNonTerminalAgentRunState(state: ToolCallBlock['tool']['state']): boolean {
    return state === 'running' || state === 'pending'
}

function shouldIgnoreAgentRunNonTerminalUpdateAfterTerminal(
    block: ToolCallBlock,
    nextState: ToolCallBlock['tool']['state'],
    event: Record<string, unknown>
): boolean {
    if (!isTerminalAgentRunState(block.tool.state)) return false
    if (!isNonTerminalAgentRunState(nextState)) return false

    const activityKind = getEventString(event, 'activityKind') ?? getEventString(event, 'activity_kind')
    return activityKind === 'wait_agent' || activityKind === 'close_agent'
}

function isCloseAgentCleanupUpdate(event: Record<string, unknown>): boolean {
    const activityKind = getEventString(event, 'activityKind') ?? getEventString(event, 'activity_kind')
    if (activityKind === 'close_agent' || activityKind === 'closed') return true

    const activity = getEventString(event, 'activity')
    const statusText = getEventString(event, 'statusText') ?? getEventString(event, 'status_text')
    if (activityKind !== 'canceled' || (activity !== 'Closed' && statusText !== 'Closed')) return false

    const result = isObject(event.result) ? event.result : null
    return Boolean(result && (isObject(result.previous_status) || isObject(result.previousStatus)))
}

function shouldIgnoreAgentRunCloseCleanupAfterTerminal(
    block: ToolCallBlock,
    status: string | null,
    event: Record<string, unknown>
): boolean {
    if (!isTerminalAgentRunState(block.tool.state)) return false
    if (status === 'failed' || status === 'error') return false
    return isCloseAgentCleanupUpdate(event)
}

function getAgentRunDisplayPatch(event: Record<string, unknown>): Record<string, unknown> {
    const patch: Record<string, unknown> = {}
    const summary = getEventString(event, 'summary')
    const activity = getEventString(event, 'activity')
    const activityKind = getEventString(event, 'activityKind') ?? getEventString(event, 'activity_kind')

    if (summary) patch.summary = summary
    if (activity) patch.activity = activity
    if (activityKind) patch.activityKind = activityKind

    return patch
}

function getAgentRunFingerprint(event: Record<string, unknown>): string | null {
    const summary = getEventString(event, 'summary')
    if (summary) return summary

    const input = isObject(event.input) ? event.input : null
    const direct = input ? asString(input.message) ?? asString(input.prompt) : null
    if (direct) return direct.replace(/\s+/g, ' ').trim()

    if (input && Array.isArray(input.items)) {
        const text = input.items
            .map((item) => isObject(item) ? asString(item.text) : null)
            .filter((part): part is string => Boolean(part))
            .join('\n\n')
            .replace(/\s+/g, ' ')
            .trim()
        return text.length > 0 ? text : null
    }

    return null
}

function isAgentNotFoundUpdate(event: Record<string, unknown>): boolean {
    const status = getEventString(event, 'status')
    const activityKind = getEventString(event, 'activityKind') ?? getEventString(event, 'activity_kind')
    return status === 'notFound'
        || status === 'not_found'
        || activityKind === 'not_found'
}

function isAgentToolOnlyUpdate(event: Record<string, unknown>): boolean {
    const activityKind = getEventString(event, 'activityKind') ?? getEventString(event, 'activity_kind')
    return activityKind === 'wait_agent'
        || activityKind === 'send_input'
        || activityKind === 'resume_agent'
        || activityKind === 'close_agent'
        || isAgentNotFoundUpdate(event)
}

function isOrphanAgentRunBlock(block: ToolCallBlock): boolean {
    if (block.children.length > 0) return false
    if (block.tool.result !== undefined) return false
    if (block.tool.state === 'completed' || block.tool.state === 'error') return false
    if (isObject(block.tool.input) && (asString(block.tool.input.agentId) || asString(block.tool.input.agent_id))) {
        return false
    }
    return true
}

function prefixAgentTraceId(agentId: string, kind: 'trace' | 'call', id: string): string {
    const prefix = `codex-agent:${agentId}:`
    return id.startsWith(prefix) ? id : `${prefix}${kind}:${id}`
}

function normalizeTraceMessage(
    agentId: string,
    message: unknown,
    source: TracedMessage,
): TracedMessage[] {
    const data = isObject(message) ? message : null
    if (!data || typeof data.type !== 'string') return []

    const traceId = prefixAgentTraceId(agentId, 'trace', asString(data.id) ?? `${source.id}:trace`)
    const createdAt = source.createdAt
    const base = {
        localId: null,
        createdAt,
        isSidechain: false,
        meta: source.meta
    }

    if (data.type === 'message' && typeof data.message === 'string') {
        return [{
            ...base,
            id: traceId,
            role: 'agent',
            content: [{ type: 'text', text: data.message, uuid: traceId, parentUUID: null }]
        } as TracedMessage]
    }

    if (data.type === 'reasoning' && typeof data.message === 'string') {
        return [{
            ...base,
            id: traceId,
            role: 'agent',
            content: [{ type: 'reasoning', text: data.message, uuid: traceId, parentUUID: null }]
        } as TracedMessage]
    }

    if (data.type === 'tool-call' && typeof data.callId === 'string') {
        const callId = prefixAgentTraceId(agentId, 'call', data.callId)
        return [{
            ...base,
            id: traceId,
            role: 'agent',
            content: [{
                type: 'tool-call',
                id: callId,
                name: asString(data.name) ?? 'unknown',
                input: data.input,
                description: null,
                uuid: traceId,
                parentUUID: null
            }]
        } as TracedMessage]
    }

    if (data.type === 'tool-call-result' && typeof data.callId === 'string') {
        const callId = prefixAgentTraceId(agentId, 'call', data.callId)
        return [{
            ...base,
            id: traceId,
            role: 'agent',
            content: [{
                type: 'tool-result',
                tool_use_id: callId,
                content: data.output,
                is_error: Boolean(data.is_error),
                uuid: traceId,
                parentUUID: null
            }]
        } as TracedMessage]
    }

    if (data.type === 'token_count') {
        return []
    }

    if (data.type === 'ready' || data.type === 'task_complete') {
        return [{
            ...base,
            id: traceId,
            role: 'event',
            content: { type: 'ready', agentId }
        } as TracedMessage]
    }

    return [{
        ...base,
        id: traceId,
        role: 'event',
        content: {
            type: 'message',
            message: asString(data.statusText) ?? asString(data.status) ?? data.type
        }
    } as TracedMessage]
}

export function reduceTimeline(
    messages: TracedMessage[],
    context: {
        permissionsById: Map<string, PermissionEntry>
        groups: Map<string, TracedMessage[]>
        consumedGroupIds: Set<string>
        titleChangesByToolUseId: Map<string, string>
        emittedTitleChangeToolUseIds: Set<string>
    }
): { blocks: ChatBlock[]; toolBlocksById: Map<string, ToolCallBlock>; hasReadyEvent: boolean } {
    const blocks: ChatBlock[] = []
    const toolBlocksById = new Map<string, ToolCallBlock>()
    const agentRunBlocksByCardId = new Map<string, ToolCallBlock>()
    const agentRunCardByAgentId = new Map<string, string>()
    const agentRunTraceMessagesByCardId = new Map<string, TracedMessage[]>()
    const pendingAgentRunCardByFingerprint = new Map<string, string>()
    let hasReadyEvent = false

    const ensureAgentRunBlock = (
        cardId: string,
        seed: {
            createdAt: number
            invokedAt?: number | null
            model?: string | null
            localId: string | null
            meta?: unknown
            input?: unknown
        }
    ): ToolCallBlock => {
        const block = ensureToolBlock(blocks, toolBlocksById, cardId, {
            createdAt: seed.createdAt,
            invokedAt: seed.invokedAt,
            model: seed.model,
            localId: seed.localId,
            meta: seed.meta,
            name: 'CodexAgent',
            input: seed.input,
            description: null
        })
        agentRunBlocksByCardId.set(cardId, block)
        return block
    }

    const refreshAgentRunChildren = (cardId: string): void => {
        const block = agentRunBlocksByCardId.get(cardId)
        if (!block) return
        const traceMessages = agentRunTraceMessagesByCardId.get(cardId) ?? []
        if (traceMessages.length === 0) {
            block.children = []
            return
        }

        const child = reduceTimeline(traceMessages, {
            permissionsById: context.permissionsById,
            groups: new Map(),
            consumedGroupIds: new Set<string>(),
            titleChangesByToolUseId: collectTitleChanges(traceMessages),
            emittedTitleChangeToolUseIds: new Set<string>()
        })
        block.children = child.blocks
    }

    const patchAgentRunInput = (block: ToolCallBlock, patch: Record<string, unknown>): void => {
        const current = isObject(block.tool.input) ? block.tool.input : {}
        block.tool.input = {
            ...current,
            ...patch
        }
    }

    const removeAgentRunBlock = (cardId: string): void => {
        const block = agentRunBlocksByCardId.get(cardId)
        if (!block) return
        const index = blocks.findIndex((candidate) => candidate === block)
        if (index !== -1) {
            blocks.splice(index, 1)
        }
        toolBlocksById.delete(cardId)
        agentRunBlocksByCardId.delete(cardId)
        agentRunTraceMessagesByCardId.delete(cardId)
        for (const [fingerprint, pendingCardId] of pendingAgentRunCardByFingerprint) {
            if (pendingCardId === cardId) {
                pendingAgentRunCardByFingerprint.delete(fingerprint)
            }
        }
    }

    const mergeAgentRunBlock = (fromCardId: string, toCardId: string, toBlock: ToolCallBlock): void => {
        if (fromCardId === toCardId) return

        const fromBlock = agentRunBlocksByCardId.get(fromCardId)
        if (!fromBlock || fromBlock === toBlock) return

        const fromInput = isObject(fromBlock.tool.input) ? fromBlock.tool.input : {}
        const toInput = isObject(toBlock.tool.input) ? toBlock.tool.input : {}
        if (Object.keys(fromInput).length > 0 || Object.keys(toInput).length > 0) {
            toBlock.tool.input = {
                ...fromInput,
                ...toInput
            }
        }

        toBlock.createdAt = Math.min(toBlock.createdAt, fromBlock.createdAt)
        toBlock.tool.createdAt = Math.min(toBlock.tool.createdAt, fromBlock.tool.createdAt)
        if (fromBlock.tool.startedAt !== null) {
            toBlock.tool.startedAt = toBlock.tool.startedAt === null
                ? fromBlock.tool.startedAt
                : Math.min(toBlock.tool.startedAt, fromBlock.tool.startedAt)
        }
        if (fromBlock.tool.completedAt !== null) {
            toBlock.tool.completedAt = toBlock.tool.completedAt === null
                ? fromBlock.tool.completedAt
                : Math.max(toBlock.tool.completedAt, fromBlock.tool.completedAt)
        }
        toBlock.durationMs = toBlock.durationMs ?? fromBlock.durationMs
        toBlock.usage = toBlock.usage ?? fromBlock.usage
        toBlock.model = toBlock.model ?? fromBlock.model

        if (!isTerminalAgentRunState(toBlock.tool.state) && isTerminalAgentRunState(fromBlock.tool.state)) {
            toBlock.tool.state = fromBlock.tool.state
        }
        if (toBlock.tool.result === undefined && fromBlock.tool.result !== undefined) {
            toBlock.tool.result = fromBlock.tool.result
        }

        const fromTrace = agentRunTraceMessagesByCardId.get(fromCardId) ?? []
        const toTrace = agentRunTraceMessagesByCardId.get(toCardId) ?? []
        if (fromTrace.length > 0 || toTrace.length > 0) {
            const mergedTrace = [...toTrace, ...fromTrace]
                .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
            agentRunTraceMessagesByCardId.set(toCardId, mergedTrace)
            agentRunTraceMessagesByCardId.delete(fromCardId)
            refreshAgentRunChildren(toCardId)
        } else if (toBlock.children.length === 0 && fromBlock.children.length > 0) {
            toBlock.children = fromBlock.children
        }

        const index = blocks.findIndex((candidate) => candidate === fromBlock)
        if (index !== -1) {
            blocks.splice(index, 1)
        }
        toolBlocksById.delete(fromCardId)
        agentRunBlocksByCardId.delete(fromCardId)

        for (const [fingerprint, pendingCardId] of pendingAgentRunCardByFingerprint) {
            if (pendingCardId === fromCardId) {
                pendingAgentRunCardByFingerprint.set(fingerprint, toCardId)
            }
        }
        for (const [mappedAgentId, mappedCardId] of agentRunCardByAgentId) {
            if (mappedCardId === fromCardId) {
                agentRunCardByAgentId.set(mappedAgentId, toCardId)
            }
        }
    }

    // Pre-scan: collect UUIDs of system-injected user turns (sidechain
    // prompts, task notifications, system reminders).  These are used below
    // to identify sentinel auto-replies ("No response requested.") whose
    // parentUUID points to one of these injected messages.
    const injectedTurnUuids = new Set<string>()
    for (const msg of messages) {
        if (msg.role !== 'agent' || !msg.isSidechain) continue
        for (const c of msg.content) {
            if (c.type === 'sidechain') {
                injectedTurnUuids.add(c.uuid)
            }
        }
    }

    for (const msg of messages) {
        if (msg.role === 'event') {
            if (msg.content.type === 'ready') {
                hasReadyEvent = true
                continue
            }
            if (msg.content.type === 'token-count') {
                continue
            }
            if (msg.content.type === 'turn-duration') {
                const targetId = msg.content.targetMessageId
                const durationMs = msg.content.durationMs as number
                type DurationBearingBlock = AgentTextBlock | AgentReasoningBlock | CliOutputBlock | ToolCallBlock
                const isDurationTarget = (b: ChatBlock): b is DurationBearingBlock =>
                    b.kind === 'agent-text' || b.kind === 'agent-reasoning' || b.kind === 'cli-output' || b.kind === 'tool-call'
                let foundIndex = -1

                if (targetId) {
                    foundIndex = blocks.findLastIndex(b => isDurationTarget(b) && (b.id === targetId || b.id.startsWith(`${targetId}:`)))
                    if (foundIndex === -1) {
                        foundIndex = blocks.findLastIndex(b => b.kind === 'tool-call' && b.tool.id === targetId)
                    }
                }

                if (foundIndex === -1) {
                    foundIndex = blocks.findLastIndex(isDurationTarget)
                }

                if (foundIndex !== -1) {
                    const b = blocks[foundIndex]
                    if (isDurationTarget(b)) {
                        b.durationMs = durationMs
                    }
                }
                continue
            }

            if (
                msg.content.type === 'agent-run-start'
                || msg.content.type === 'agent-run-update'
                || msg.content.type === 'agent-run-trace'
            ) {
                const event = msg.content as Record<string, unknown>
                const agentId = getEventString(event, 'agentId') ?? getEventString(event, 'agent_id')
                const fallbackCardId = agentId ? `codex-agent:${agentId}` : msg.id
                const rawCardId = getAgentRunCardId(event, fallbackCardId)
                const previousCardId = agentId ? agentRunCardByAgentId.get(agentId) ?? null : null
                const previousIsFallback = previousCardId !== null && isFallbackAgentRunCardId(previousCardId, agentId)
                const rawIsFallback = isFallbackAgentRunCardId(rawCardId, agentId)
                const cardId = agentId && previousCardId && !previousIsFallback && rawIsFallback
                    ? previousCardId
                    : rawCardId
                const mergeFromCardId = agentId
                    && previousCardId
                    && previousCardId !== cardId
                    && previousIsFallback
                    && !rawIsFallback
                    ? previousCardId
                    : null
                const fingerprint = getAgentRunFingerprint(event)

                if (
                    msg.content.type === 'agent-run-update'
                    && agentId
                    && !previousCardId
                    && rawIsFallback
                    && isAgentToolOnlyUpdate(event)
                ) {
                    continue
                }

                if (msg.content.type === 'agent-run-start' && !agentId && fingerprint) {
                    const previousCardId = pendingAgentRunCardByFingerprint.get(fingerprint)
                    const previousBlock = previousCardId ? agentRunBlocksByCardId.get(previousCardId) : null
                    if (previousCardId && previousCardId !== cardId && previousBlock && isOrphanAgentRunBlock(previousBlock)) {
                        removeAgentRunBlock(previousCardId)
                    }
                    pendingAgentRunCardByFingerprint.set(fingerprint, cardId)
                }

                const block = ensureAgentRunBlock(cardId, {
                    createdAt: msg.createdAt,
                    invokedAt: msg.invokedAt,
                    model: msg.model,
                    localId: msg.localId,
                    meta: msg.meta,
                    input: event.input
                })

                if (mergeFromCardId) {
                    mergeAgentRunBlock(mergeFromCardId, cardId, block)
                }
                if (agentId) {
                    agentRunCardByAgentId.set(agentId, cardId)
                }

                if (msg.content.type === 'agent-run-start') {
                    const status = getEventString(event, 'status') ?? 'running'
                    const startedAt = getAgentRunStartedAt(event) ?? msg.createdAt
                    patchAgentRunInput(block, {
                        agentId,
                        agentStatus: status,
                        statusText: getEventString(event, 'statusText') ?? getEventString(event, 'status_text') ?? 'Starting',
                        ...getAgentRunDisplayPatch(event)
                    })
                    block.tool.state = mapAgentRunStatusToToolState(status)
                    if (block.tool.state === 'running') {
                        setEarliestStartedAt(block, startedAt)
                    }
                    continue
                }

                if (msg.content.type === 'agent-run-update') {
                    const status = getEventString(event, 'status') ?? 'running'
                    const nextState = mapAgentRunStatusToToolState(status)
                    const startedAt = getAgentRunStartedAt(event)
                    if (
                        shouldIgnoreAgentRunNonTerminalUpdateAfterTerminal(block, nextState, event)
                        || shouldIgnoreAgentRunCloseCleanupAfterTerminal(block, status, event)
                    ) {
                        continue
                    }
                    patchAgentRunInput(block, {
                        agentId,
                        agentStatus: status,
                        statusText: getEventString(event, 'statusText') ?? getEventString(event, 'status_text') ?? status,
                        ...getAgentRunDisplayPatch(event)
                    })
                    block.tool.state = nextState
                    if (block.tool.state === 'running') {
                        setEarliestStartedAt(block, startedAt ?? msg.createdAt)
                    }
                    if (block.tool.state === 'completed' || block.tool.state === 'error') {
                        setEarliestStartedAt(block, startedAt)
                        block.tool.completedAt = getAgentRunCompletedAt(event) ?? msg.createdAt
                    }
                    if ('result' in event) {
                        block.tool.result = event.result
                    } else if ('error' in event) {
                        block.tool.result = event.error
                    } else if ('spawnResult' in event) {
                        block.tool.result = event.spawnResult
                    }
                    continue
                }

                if (msg.content.type === 'agent-run-trace') {
                    const traceAgentId = agentId
                    if (!traceAgentId) continue
                    const startedAt = getAgentRunStartedAt(event)
                    const traceCardId = agentRunCardByAgentId.get(traceAgentId) ?? cardId
                    const traceBlock = ensureAgentRunBlock(traceCardId, {
                        createdAt: msg.createdAt,
                        invokedAt: msg.invokedAt,
                        model: msg.model,
                        localId: msg.localId,
                        meta: msg.meta,
                        input: agentRunBlocksByCardId.has(traceCardId) ? undefined : { agentId: traceAgentId }
                    })
                    const tracePatch: Record<string, unknown> = {
                        agentId: traceAgentId,
                        agentStatus: traceBlock.tool.state,
                        ...getAgentRunDisplayPatch(event)
                    }
                    if (!isTerminalAgentRunState(traceBlock.tool.state)) {
                        tracePatch.statusText = getEventString(event, 'statusText') ?? getEventString(event, 'status_text') ?? 'Running'
                    }
                    patchAgentRunInput(traceBlock, {
                        ...tracePatch
                    })
                    const traceMessages = agentRunTraceMessagesByCardId.get(traceCardId) ?? []
                    traceMessages.push(...normalizeTraceMessage(traceAgentId, event.message, msg))
                    agentRunTraceMessagesByCardId.set(traceCardId, traceMessages)
                    refreshAgentRunChildren(traceCardId)
                    if (traceBlock.tool.state !== 'completed' && traceBlock.tool.state !== 'error') {
                        traceBlock.tool.state = 'running'
                        setEarliestStartedAt(traceBlock, startedAt ?? msg.createdAt)
                    }
                    continue
                }
            }

            blocks.push({
                kind: 'agent-event',
                id: msg.id,
                createdAt: msg.createdAt,
                invokedAt: msg.invokedAt,
                model: msg.model,
                event: msg.content,
                meta: msg.meta
            })
            continue
        }

        const event = parseMessageAsEvent(msg)
        if (event) {
            blocks.push({
                kind: 'agent-event',
                id: msg.id,
                createdAt: msg.createdAt,
                invokedAt: msg.invokedAt,
                model: msg.model,
                event,
                meta: msg.meta
            })
            continue
        }

        if (msg.role === 'user') {
            if (isCliOutputText(msg.content.text, msg.meta)) {
                blocks.push(createCliOutputBlock({
                    id: msg.id,
                    localId: msg.localId,
                    createdAt: msg.createdAt,
                    invokedAt: msg.invokedAt,
                    text: msg.content.text,
                    source: 'user',
                    meta: msg.meta
                }))
                continue
            }
            blocks.push({
                kind: 'user-text',
                id: msg.id,
                localId: msg.localId,
                createdAt: msg.createdAt,
                invokedAt: msg.invokedAt,
                text: msg.content.text,
                attachments: msg.content.attachments,
                status: msg.status,
                originalText: msg.originalText,
                meta: msg.meta
            })
            continue
        }

        if (msg.role === 'agent') {
            // When the message contains a Task/Agent tool_use, Claude often writes
            // the prompt as a text block before the tool_use block.  We only want to
            // suppress that exact prompt text — not every text block in the message.
            const taskToolCall = msg.content.find(
                (c) => c.type === 'tool-call' && isSubagentToolName(c.name)
            )
            const taskPromptText: string | null = (() => {
                if (!taskToolCall || taskToolCall.type !== 'tool-call') return null
                const input = taskToolCall.input
                if (typeof input === 'object' && input !== null && 'prompt' in input) {
                    const p = (input as { prompt: unknown }).prompt
                    if (typeof p === 'string') return p
                }
                return null
            })()

            for (let idx = 0; idx < msg.content.length; idx += 1) {
                const c = msg.content[idx]
                if (c.type === 'text') {
                    // Skip "No response requested." — Claude's sentinel auto-response
                    // to system-injected messages (task notifications, system reminders).
                    //
                    // Structural checks to avoid false positives:
                    //   1. msg.content.length === 1 — no tool calls or reasoning alongside
                    //   2. c.parentUUID points to a known injected turn UUID (collected
                    //      in pre-scan from sidechain content blocks)
                    //   3. Exact text match on the known sentinel phrase
                    if (
                        msg.content.length === 1 &&
                        c.parentUUID !== null &&
                        injectedTurnUuids.has(c.parentUUID)
                    ) {
                        const trimmedText = c.text.trim()
                        if (trimmedText === 'No response requested.' || trimmedText === 'No response requested') {
                            continue
                        }
                    }

                    // Skip text blocks that are just the Task tool prompt (already shown in tool card)
                    if (taskPromptText && c.text.trim() === taskPromptText.trim()) continue

                    if (isCliOutputText(c.text, msg.meta)) {
                        blocks.push(createCliOutputBlock({
                            id: `${msg.id}:${idx}`,
                            localId: msg.localId,
                            createdAt: msg.createdAt,
                            invokedAt: msg.invokedAt,
                            usage: msg.usage,
                            model: msg.model,
                            text: c.text,
                            source: 'assistant',
                            meta: msg.meta
                        }))
                        continue
                    }
                    blocks.push({
                        kind: 'agent-text',
                        id: `${msg.id}:${idx}`,
                        localId: msg.localId,
                        createdAt: msg.createdAt,
                        invokedAt: msg.invokedAt,
                        usage: msg.usage,
                        model: msg.model,
                        text: c.text,
                        meta: msg.meta
                    })
                    continue
                }

                if (c.type === 'reasoning') {
                    blocks.push({
                        kind: 'agent-reasoning',
                        id: `${msg.id}:${idx}`,
                        localId: msg.localId,
                        createdAt: msg.createdAt,
                        invokedAt: msg.invokedAt,
                        usage: msg.usage,
                        model: msg.model,
                        text: c.text,
                        meta: msg.meta
                    })
                    continue
                }

                if (c.type === 'summary') {
                    blocks.push({
                        kind: 'agent-event',
                        id: `${msg.id}:${idx}`,
                        createdAt: msg.createdAt,
                        invokedAt: msg.invokedAt,
                        model: msg.model,
                        event: { type: 'message', message: c.summary },
                        meta: msg.meta
                    })
                    continue
                }

                if (c.type === 'tool-call') {
                    if (isChangeTitleToolName(c.name)) {
                        const title = context.titleChangesByToolUseId.get(c.id) ?? extractTitleFromChangeTitleInput(c.input)
                        if (title && !context.emittedTitleChangeToolUseIds.has(c.id)) {
                            context.emittedTitleChangeToolUseIds.add(c.id)
                            blocks.push({
                                kind: 'agent-event',
                                id: `${msg.id}:${idx}`,
                                createdAt: msg.createdAt,
                                invokedAt: msg.invokedAt,
                                model: msg.model,
                                event: { type: 'title-changed', title },
                                meta: msg.meta
                            })
                        }
                        continue
                    }

                    const permission = context.permissionsById.get(c.id)?.permission

                    const block = ensureToolBlock(blocks, toolBlocksById, c.id, {
                        createdAt: msg.createdAt,
                        invokedAt: msg.invokedAt,
                        usage: msg.usage,
                        model: msg.model,
                        localId: msg.localId,
                        meta: msg.meta,
                        name: c.name,
                        input: c.input,
                        description: c.description,
                        permission
                    })

                    if (block.tool.state === 'pending') {
                        block.tool.state = 'running'
                        block.tool.startedAt = msg.createdAt
                    }

                    if (isSubagentToolName(c.name) && !context.consumedGroupIds.has(msg.id)) {
                        const sidechain = context.groups.get(msg.id) ?? null
                        if (sidechain && sidechain.length > 0) {
                            context.consumedGroupIds.add(msg.id)
                            const child = reduceTimeline(sidechain, context)
                            hasReadyEvent = hasReadyEvent || child.hasReadyEvent
                            block.children = child.blocks
                        }
                    }
                    continue
                }

                if (c.type === 'tool-result') {
                    const title = context.titleChangesByToolUseId.get(c.tool_use_id) ?? null
                    if (title) {
                        if (!context.emittedTitleChangeToolUseIds.has(c.tool_use_id)) {
                            context.emittedTitleChangeToolUseIds.add(c.tool_use_id)
                            blocks.push({
                                kind: 'agent-event',
                                id: `${msg.id}:${idx}`,
                                createdAt: msg.createdAt,
                                invokedAt: msg.invokedAt,
                                model: msg.model,
                                event: { type: 'title-changed', title },
                                meta: msg.meta
                            })
                        }
                        continue
                    }

                    const permissionEntry = context.permissionsById.get(c.tool_use_id)
                    const permissionFromResult = c.permissions ? ({
                        id: c.tool_use_id,
                        status: c.permissions.result === 'approved' ? 'approved' : 'denied',
                        date: c.permissions.date,
                        mode: c.permissions.mode,
                        allowedTools: c.permissions.allowedTools,
                        decision: c.permissions.decision
                    } satisfies ToolPermission) : undefined

                    const permission = (() => {
                        if (permissionFromResult && permissionEntry?.permission) {
                            return {
                                ...permissionEntry.permission,
                                ...permissionFromResult,
                                allowedTools: permissionFromResult.allowedTools ?? permissionEntry.permission.allowedTools,
                                decision: permissionFromResult.decision ?? permissionEntry.permission.decision
                            } satisfies ToolPermission
                        }
                        return permissionFromResult ?? permissionEntry?.permission
                    })()

                    const block = ensureToolBlock(blocks, toolBlocksById, c.tool_use_id, {
                        createdAt: msg.createdAt,
                        invokedAt: msg.invokedAt,
                        usage: msg.usage,
                        model: msg.model,
                        localId: msg.localId,
                        meta: msg.meta,
                        name: permissionEntry?.toolName ?? 'Tool',
                        input: permissionEntry?.input ?? null,
                        description: null,
                        permission
                    })

                    block.tool.result = c.content
                    block.tool.completedAt = msg.createdAt
                    block.tool.state = c.is_error ? 'error' : 'completed'
                    continue
                }

                if (c.type === 'sidechain') {
                    // Extract task-notification summaries as visible events
                    const trimmedPrompt = c.prompt.trimStart()
                    if (trimmedPrompt.startsWith('<task-notification>')) {
                        const summary = trimmedPrompt.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim()
                        if (summary) {
                            blocks.push({
                                kind: 'agent-event',
                                id: `${msg.id}:${idx}`,
                                createdAt: msg.createdAt,
                                invokedAt: msg.invokedAt,
                                model: msg.model,
                                event: { type: 'message', message: summary },
                                meta: msg.meta
                            })
                        }
                    }
                    // Skip rendering prompt text (already in parent Task tool card or not user-visible)
                    continue
                }
            }
        }
    }

    return { blocks: mergeCliOutputBlocks(blocks), toolBlocksById, hasReadyEvent }
}
