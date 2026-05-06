import type { AgentEvent, NormalizedAgentContent, NormalizedMessage, ToolResultPermission } from '@/chat/types'
import { AGENT_MESSAGE_PAYLOAD_TYPE, asNumber, asString, isObject } from '@hapi/protocol'
import { isClaudeChatVisibleMessage } from '@hapi/protocol/messages'

function normalizeToolResultPermissions(value: unknown): ToolResultPermission | undefined {
    if (!isObject(value)) return undefined
    const date = asNumber(value.date)
    const result = value.result
    if (date === null) return undefined
    if (result !== 'approved' && result !== 'denied') return undefined

    const mode = asString(value.mode) ?? undefined
    const allowedTools = Array.isArray(value.allowedTools)
        ? value.allowedTools.filter((tool) => typeof tool === 'string')
        : undefined
    const decision = value.decision
    const normalizedDecision = decision === 'approved' || decision === 'approved_for_session' || decision === 'denied' || decision === 'abort'
        ? decision
        : undefined

    return {
        date,
        result,
        mode,
        allowedTools,
        decision: normalizedDecision
    }
}

function normalizeAgentEvent(value: unknown): AgentEvent | null {
    if (!isObject(value) || typeof value.type !== 'string') return null
    return value as AgentEvent
}

function normalizeCodexTokenUsage(value: unknown, data?: Record<string, unknown>) {
    const info = isObject(value) ? value : null
    if (!info) return null
    const scope = data && isObject(data.scope) ? data.scope : null
    // Codex reports both:
    // - `total`: cumulative usage for the whole session (can be millions).
    // - `last`: current turn/request usage, which matches the live context bar.
    // Prefer `last`; falling back to `total` keeps older payloads working.
    const usageSource = isObject(info.last)
        ? info.last
        : isObject(info.lastTokenUsage)
            ? info.lastTokenUsage
            : isObject(info.last_token_usage)
                ? info.last_token_usage
                : isObject(info.total)
                    ? info.total
                    : isObject(info.totalTokenUsage)
                        ? info.totalTokenUsage
                        : isObject(info.total_token_usage)
                            ? info.total_token_usage
                            : info
    const inputTokens = asNumber(usageSource.inputTokens ?? usageSource.input_tokens)
    const outputTokens = asNumber(usageSource.outputTokens ?? usageSource.output_tokens)
    if (inputTokens === null || outputTokens === null) return null

    return {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        // Codex `inputTokens` already includes cached input tokens; expose cache
        // hits for display, but use `context_tokens` to avoid double-counting.
        cache_creation_input_tokens: undefined,
        cache_read_input_tokens: asNumber(
            usageSource.cachedInputTokens
            ?? usageSource.cached_input_tokens
            ?? usageSource.cacheReadInputTokens
            ?? usageSource.cache_read_input_tokens
        ) ?? undefined,
        context_tokens: inputTokens,
        context_window: asNumber(info.modelContextWindow ?? info.model_context_window) ?? undefined,
        thread_id: asString(
            data?.thread_id
            ?? data?.threadId
            ?? scope?.thread_id
            ?? scope?.threadId
            ?? info.thread_id
            ?? info.threadId
        ) ?? undefined,
        scope_role: asString(data?.scope_role ?? data?.scopeRole ?? scope?.role) ?? undefined
    }
}

function normalizePlanStatus(value: unknown): 'pending' | 'in_progress' | 'completed' {
    const raw = typeof value === 'string' ? value.trim().toLowerCase().replace(/[\s-]/g, '_') : ''
    if (raw === 'completed' || raw === 'complete' || raw === 'done') return 'completed'
    if (raw === 'in_progress' || raw === 'inprogress' || raw === 'active' || raw === 'running') return 'in_progress'
    return 'pending'
}

function normalizePlanEntries(value: unknown): Array<{ step: string; status: 'pending' | 'in_progress' | 'completed' }> {
    const record = isObject(value) ? value : null
    const entries = Array.isArray(value)
        ? value
        : Array.isArray(record?.plan)
            ? record.plan
            : Array.isArray(record?.items)
                ? record.items
                : Array.isArray(record?.steps)
                    ? record.steps
                    : []

    const plan: Array<{ step: string; status: 'pending' | 'in_progress' | 'completed' }> = []
    for (const entry of entries) {
        if (typeof entry === 'string') {
            plan.push({ step: entry, status: 'pending' })
            continue
        }
        if (!isObject(entry)) continue
        const step = asString(entry.step)
            ?? asString(entry.content)
            ?? asString(entry.text)
            ?? asString(entry.title)
            ?? asString(entry.description)
        if (!step) continue
        plan.push({
            step,
            status: normalizePlanStatus(entry.status ?? entry.state)
        })
    }
    return plan
}

function normalizeAssistantOutput(
    messageId: string,
    localId: string | null,
    createdAt: number,
    data: Record<string, unknown>,
    meta?: unknown,
): NormalizedMessage | null {
    const uuid = asString(data.uuid) ?? messageId
    const parentUUID = asString(data.parentUuid) ?? null
    const isSidechain = Boolean(data.isSidechain)

    const message = isObject(data.message) ? data.message : null
    if (!message) return null

    const modelContent = message.content
    const blocks: NormalizedAgentContent[] = []

    if (typeof modelContent === 'string') {
        blocks.push({ type: 'text', text: modelContent, uuid, parentUUID })
    } else if (Array.isArray(modelContent)) {
        for (const block of modelContent) {
            if (!isObject(block) || typeof block.type !== 'string') continue
            if (block.type === 'text' && typeof block.text === 'string') {
                blocks.push({ type: 'text', text: block.text, uuid, parentUUID })
                continue
            }
            if (block.type === 'thinking' && typeof block.thinking === 'string') {
                blocks.push({ type: 'reasoning', text: block.thinking, uuid, parentUUID })
                continue
            }
            if (block.type === 'tool_use' && typeof block.id === 'string') {
                const name = asString(block.name) ?? 'Tool'
                const input = 'input' in block ? (block as Record<string, unknown>).input : undefined
                const description = isObject(input) && typeof input.description === 'string' ? input.description : null
                blocks.push({ type: 'tool-call', id: block.id, name, input, description, uuid, parentUUID })
            }
        }
    }

    const usage = isObject(message.usage) ? (message.usage as Record<string, unknown>) : null
    const inputTokens = usage ? asNumber(usage.input_tokens) : null
    const outputTokens = usage ? asNumber(usage.output_tokens) : null
    const model = asString(message.model) ?? null

    return {
        id: messageId,
        localId,
        createdAt,
        model,
        role: 'agent',
        isSidechain,
        content: blocks,
        meta,
        usage: inputTokens !== null && outputTokens !== null ? {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cache_creation_input_tokens: asNumber(usage?.cache_creation_input_tokens) ?? undefined,
            cache_read_input_tokens: asNumber(usage?.cache_read_input_tokens) ?? undefined,
            service_tier: asString(usage?.service_tier) ?? undefined
        } : undefined
    }
}

function normalizeUserOutput(
    messageId: string,
    localId: string | null,
    createdAt: number,
    data: Record<string, unknown>,
    meta?: unknown,
): NormalizedMessage | null {
    const uuid = asString(data.uuid) ?? messageId
    const parentUUID = asString(data.parentUuid) ?? null
    const isSidechain = Boolean(data.isSidechain)

    const message = isObject(data.message) ? data.message : null
    if (!message) return null

    const messageContent = message.content

    if (isSidechain && typeof messageContent === 'string') {
        return {
            id: messageId,
            localId,
            createdAt,
            role: 'agent',
            isSidechain: true,
            content: [{ type: 'sidechain', uuid, parentUUID, prompt: messageContent }]
        }
    }

    // Handle system-injected messages that arrive as type:'user' through
    // the agent output path. Real user text goes through normalizeUserRecord.
    //
    // All string-content user messages here are system-injected (subagent
    // prompts, task notifications, system reminders, etc.).  Always emit as
    // sidechain so the uuid/parentUUID chain is preserved — the reducer uses
    // sidechain UUIDs to identify sentinel auto-replies.  Task-notification
    // summaries are extracted as events by the reducer, not here.
    if (typeof messageContent === 'string') {
        return {
            id: messageId,
            localId,
            createdAt,
            role: 'agent',
            isSidechain: true,
            content: [{ type: 'sidechain', uuid, parentUUID, prompt: messageContent }]
        }
    }

    // Sidechain user messages with array content (e.g. subagent prompts
    // that Claude Code serialised as [{type:'text', text:'...'}] instead
    // of a plain string).  Extract the text and treat as sidechain so the
    // tracer can match it to the parent Task tool call.
    if (isSidechain && Array.isArray(messageContent)) {
        const textParts = messageContent
            .filter((b: unknown) => isObject(b) && b.type === 'text' && typeof b.text === 'string')
            .map((b: Record<string, unknown>) => b.text as string)
        if (textParts.length > 0) {
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'agent',
                isSidechain: true,
                content: [{ type: 'sidechain', uuid, parentUUID, prompt: textParts.join('\n\n') }]
            }
        }
    }

    // Non-sidechain array content that is all text blocks — these are real
    // user messages that the CLI wrapped as agent output because
    // isExternalUserMessage rejects array content. Emit as role:'user' so
    // they display in the user lane.
    if (!isSidechain && Array.isArray(messageContent)) {
        const textParts = messageContent
            .filter((b: unknown) => isObject(b) && b.type === 'text' && typeof b.text === 'string')
            .map((b: Record<string, unknown>) => b.text as string)
        if (textParts.length > 0 && textParts.length === messageContent.length) {
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'user',
                isSidechain: false,
                content: { type: 'text', text: textParts.join('\n\n') },
                meta
            }
        }
    }

    const blocks: NormalizedAgentContent[] = []

    if (Array.isArray(messageContent)) {
        for (const block of messageContent) {
            if (!isObject(block) || typeof block.type !== 'string') continue
            if (block.type === 'text' && typeof block.text === 'string') {
                blocks.push({ type: 'text', text: block.text, uuid, parentUUID })
                continue
            }
            if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
                const isError = Boolean(block.is_error)
                const rawContent = 'content' in block ? (block as Record<string, unknown>).content : undefined
                const embeddedToolUseResult = 'toolUseResult' in data ? (data as Record<string, unknown>).toolUseResult : null

                const permissions = normalizeToolResultPermissions(block.permissions)

                blocks.push({
                    type: 'tool-result',
                    tool_use_id: block.tool_use_id,
                    content: embeddedToolUseResult ?? rawContent,
                    is_error: isError,
                    uuid,
                    parentUUID,
                    permissions
                })
            }
        }
    }

    return {
        id: messageId,
        localId,
        createdAt,
        role: 'agent',
        isSidechain,
        content: blocks,
        meta
    }
}

export function isSkippableAgentContent(content: unknown): boolean {
    if (!isObject(content) || content.type !== 'output') return false
    const data = isObject(content.data) ? content.data : null
    if (!data) return false
    if (Boolean(data.isMeta) || Boolean(data.isCompactSummary)) return true
    return !isClaudeChatVisibleMessage({ type: data.type, subtype: data.subtype })
}

export function isCodexContent(content: unknown): boolean {
    return isObject(content) && content.type === AGENT_MESSAGE_PAYLOAD_TYPE
}

export function normalizeAgentRecord(
    messageId: string,
    localId: string | null,
    createdAt: number,
    content: unknown,
    meta?: unknown,
): NormalizedMessage | null {
    if (!isObject(content) || typeof content.type !== 'string') return null

    if (content.type === 'output') {
        const data = isObject(content.data) ? content.data : null
        if (!data || typeof data.type !== 'string') return null

        // Skip meta/compact-summary messages (parity with hapi-app)
        if (data.isMeta) return null
        if (data.isCompactSummary) return null
        if (!isClaudeChatVisibleMessage({ type: data.type, subtype: data.subtype })) return null

        if (data.type === 'assistant') {
            return normalizeAssistantOutput(messageId, localId, createdAt, data, meta)
        }
        if (data.type === 'user') {
            return normalizeUserOutput(messageId, localId, createdAt, data, meta)
        }
        if (data.type === 'summary' && typeof data.summary === 'string') {
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'agent',
                isSidechain: false,
                content: [{ type: 'summary', summary: data.summary }],
                meta
            }
        }
        if (data.type === 'system' && data.subtype === 'api_error') {
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'event',
                content: {
                    type: 'api-error',
                    retryAttempt: asNumber(data.retryAttempt) ?? 0,
                    maxRetries: asNumber(data.maxRetries) ?? 0,
                    error: data.error
                },
                isSidechain: false,
                meta
            }
        }
        if (data.type === 'system' && data.subtype === 'turn_duration') {
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'event',
                content: {
                    type: 'turn-duration',
                    durationMs: asNumber(data.durationMs) ?? 0,
                    targetMessageId: asString(data.messageId) ?? undefined
                },
                isSidechain: false,
                meta
            }
        }
        if (data.type === 'system' && data.subtype === 'microcompact_boundary') {
            const metadata = isObject(data.microcompactMetadata) ? data.microcompactMetadata : null
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'event',
                content: {
                    type: 'microcompact',
                    trigger: asString(metadata?.trigger) ?? 'auto',
                    preTokens: asNumber(metadata?.preTokens) ?? 0,
                    tokensSaved: asNumber(metadata?.tokensSaved) ?? 0
                },
                isSidechain: false,
                meta
            }
        }
        if (data.type === 'system' && data.subtype === 'compact_boundary') {
            const metadata = isObject(data.compactMetadata) ? data.compactMetadata : null
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'event',
                content: {
                    type: 'compact',
                    trigger: asString(metadata?.trigger) ?? 'auto',
                    preTokens: asNumber(metadata?.preTokens) ?? 0
                },
                isSidechain: false,
                meta
            }
        }
        return null
    }

    if (content.type === 'event') {
        const event = normalizeAgentEvent(content.data)
        if (!event) return null
        return {
            id: messageId,
            localId,
            createdAt,
            role: 'event',
            content: event,
            isSidechain: false,
            meta
        }
    }

    if (content.type === AGENT_MESSAGE_PAYLOAD_TYPE) {
        const data = isObject(content.data) ? content.data : null
        if (!data || typeof data.type !== 'string') return null

        if (
            data.type === 'agent-run-start'
            || data.type === 'agent-run-update'
            || data.type === 'agent-run-trace'
        ) {
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'event',
                content: data as AgentEvent,
                isSidechain: false,
                meta
            }
        }

        if (data.type === 'message' && typeof data.message === 'string') {
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'agent',
                isSidechain: false,
                content: [{ type: 'text', text: data.message, uuid: messageId, parentUUID: null }],
                meta
            }
        }

        if (data.type === 'reasoning' && typeof data.message === 'string') {
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'agent',
                isSidechain: false,
                content: [{ type: 'reasoning', text: data.message, uuid: messageId, parentUUID: null }],
                meta
            }
        }

        if (data.type === 'context_compacted') {
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'event',
                content: {
                    type: 'compact',
                    trigger: asString(data.trigger) ?? 'auto',
                    preTokens: asNumber(data.preTokens ?? data.pre_tokens) ?? 0
                },
                isSidechain: false,
                meta
            }
        }

        if (data.type === 'token_count') {
            const usage = normalizeCodexTokenUsage(data.info, data)
            return usage ? {
                id: messageId,
                localId,
                createdAt,
                role: 'event',
                content: {
                    type: 'token-count',
                    info: data.info
                },
                isSidechain: false,
                meta,
                usage
            } : null
        }

        if (data.type === 'tool-call' && typeof data.callId === 'string') {
            const uuid = asString(data.id) ?? messageId
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: data.callId,
                    name: asString(data.name) ?? 'unknown',
                    input: data.input,
                    description: null,
                    uuid,
                    parentUUID: null
                }],
                meta
            }
        }

        if (data.type === 'tool-call-result' && typeof data.callId === 'string') {
            const uuid = asString(data.id) ?? messageId
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-result',
                    tool_use_id: data.callId,
                    content: data.output,
                    is_error: Boolean(data.is_error),
                    uuid,
                    parentUUID: null
                }],
                meta
            }
        }

        if (data.type === 'plan_update') {
            const plan = normalizePlanEntries(data.plan ?? data.update ?? data.items ?? data.steps ?? data)
            if (plan.length === 0) return null
            const uuid = asString(data.id) ?? messageId
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'agent',
                isSidechain: false,
                content: [
                    {
                        type: 'tool-call',
                        id: 'codex-plan-state',
                        name: 'update_plan',
                        input: {
                            plan,
                            source: 'codex'
                        },
                        description: null,
                        uuid,
                        parentUUID: null
                    },
                    {
                        type: 'tool-result',
                        tool_use_id: 'codex-plan-state',
                        content: {
                            plan,
                            source: 'codex',
                            status: 'updated'
                        },
                        is_error: false,
                        uuid: `${uuid}:result`,
                        parentUUID: null
                    }
                ],
                meta
            }
        }
    }

    return null
}
