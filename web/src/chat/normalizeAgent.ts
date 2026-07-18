import type { AgentEvent, InternalMessageKind, NormalizedAgentContent, NormalizedMessage, ToolResultPermission } from '@/chat/types'
import { AGENT_MESSAGE_PAYLOAD_TYPE, asNumber, asString, isObject } from '@hapi/protocol'
import { isClaudeChatVisibleMessage } from '@hapi/protocol/messages'
import type { AttachmentMetadata } from '@/types/api'
import { isSafeAttachmentPreviewUrl } from '@/lib/safeAttachmentPreviewUrl'
import { classifyGrokExtensionForDisplay, shouldHideGrokSessionEventMessage } from './grokExtensions'

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

function tokenDelta(preTokens: number | null, postTokens: number | null): number | undefined {
    if (preTokens === null || postTokens === null) return undefined
    const saved = preTokens - postTokens
    return saved > 0 ? saved : undefined
}

const INTERNAL_MESSAGE_KINDS: ReadonlySet<string> = new Set([
    'background_notification',
    'internal_tool_result',
    'internal_sidechain',
    'internal_meta',
    'internal_plan_restart',
    'internal_command_name',
    'internal_local_command_caveat',
    'internal_system_reminder'
])

const PLAN_FAKE_RESTART = 'PlEaZe Continue with plan.'

function asInternalMessageKind(value: unknown): InternalMessageKind | undefined {
    return typeof value === 'string' && INTERNAL_MESSAGE_KINDS.has(value)
        ? value as InternalMessageKind
        : undefined
}

function classifyInternalUserPrompt(prompt: string): InternalMessageKind | undefined {
    const trimmed = prompt.trimStart()
    if (trimmed.trimEnd() === PLAN_FAKE_RESTART) return 'internal_plan_restart'
    if (trimmed.startsWith('<task-notification>')) return 'background_notification'
    if (trimmed.startsWith('<command-name>')) return 'internal_command_name'
    if (trimmed.startsWith('<local-command-caveat>')) return 'internal_local_command_caveat'
    if (trimmed.startsWith('<system-reminder>')) return 'internal_system_reminder'
    return undefined
}

function sidechainContent(
    uuid: string,
    parentUUID: string | null,
    prompt: string,
    kind?: InternalMessageKind
): NormalizedAgentContent {
    return {
        type: 'sidechain',
        uuid,
        parentUUID,
        prompt,
        ...(kind ? { kind } : {})
    }
}

function parseAttachmentMetadata(raw: unknown): AttachmentMetadata[] {
    if (!Array.isArray(raw)) return []
    const attachments: AttachmentMetadata[] = []
    for (const item of raw) {
        if (
            isObject(item)
            && typeof item.id === 'string'
            && typeof item.filename === 'string'
            && typeof item.mimeType === 'string'
            && typeof item.size === 'number'
            && typeof item.path === 'string'
        ) {
            const previewUrl = typeof item.previewUrl === 'string' ? item.previewUrl : undefined
            if (previewUrl && !isSafeAttachmentPreviewUrl(previewUrl, item.mimeType)) continue
            attachments.push({
                id: item.id,
                filename: item.filename,
                mimeType: item.mimeType,
                size: item.size,
                path: item.path,
                previewUrl
            })
        }
    }
    return attachments
}

function normalizeAssistantOutput(
    messageId: string,
    localId: string | null,
    createdAt: number,
    data: Record<string, unknown>,
    meta?: unknown
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

    return {
        id: messageId,
        localId,
        createdAt,
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
    meta?: unknown
): NormalizedMessage | null {
    const uuid = asString(data.uuid) ?? messageId
    const parentUUID = asString(data.parentUuid) ?? null
    const isSidechain = Boolean(data.isSidechain)
    const metaMessageKind = asInternalMessageKind(isObject(meta) ? meta.messageKind : undefined)

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
            content: [sidechainContent(
                uuid,
                parentUUID,
                messageContent,
                metaMessageKind ?? classifyInternalUserPrompt(messageContent) ?? 'internal_sidechain'
            )],
            meta
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
            content: [sidechainContent(
                uuid,
                parentUUID,
                messageContent,
                metaMessageKind ?? classifyInternalUserPrompt(messageContent)
            )],
            meta
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
                content: [sidechainContent(
                    uuid,
                    parentUUID,
                    textParts.join('\n\n'),
                    metaMessageKind ?? 'internal_sidechain'
                )],
                meta
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
    if (!isObject(content)) return false
    if (content.type === 'event') {
        const event = isObject(content.data) ? content.data : null
        return event?.type === 'message'
            && typeof event.message === 'string'
            && shouldHideGrokSessionEventMessage(event.message)
    }
    if (content.type !== 'output') return false
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
    meta?: unknown
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
                    durationMs: asNumber(data.durationMs) ?? 0
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
            const preTokens = asNumber(metadata?.preTokens)
            const postTokens = asNumber(metadata?.postTokens)
            const durationMs = asNumber(metadata?.durationMs)
            const tokensSaved = asNumber(metadata?.tokensSaved) ?? tokenDelta(preTokens, postTokens)
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'event',
                content: {
                    type: 'compact',
                    source: 'claude',
                    trigger: asString(metadata?.trigger) ?? 'auto',
                    ...(preTokens !== null ? { preTokens } : {}),
                    ...(postTokens !== null ? { postTokens } : {}),
                    ...(tokensSaved !== undefined ? { tokensSaved } : {}),
                    ...(durationMs !== null ? { durationMs } : {})
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
        if (event.type === 'message'
            && typeof event.message === 'string'
            && shouldHideGrokSessionEventMessage(event.message)) return null
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

        if (data.type === 'context_compacted') {
            const preTokens = asNumber(
                data.previousTokens
                ?? data.previous_tokens
                ?? data.previousTokenCount
                ?? data.previous_token_count
            )
            const postTokens = asNumber(data.tokens ?? data.tokenCount ?? data.token_count)
            const tokensSaved = asNumber(data.tokensSaved ?? data.tokens_saved) ?? tokenDelta(preTokens, postTokens)
            const trigger = asString(data.trigger)
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'event',
                content: {
                    type: 'compact',
                    source: 'codex',
                    ...(trigger ? { trigger } : {}),
                    ...(preTokens !== null ? { preTokens } : {}),
                    ...(postTokens !== null ? { postTokens } : {}),
                    ...(tokensSaved !== undefined ? { tokensSaved } : {})
                },
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

        if (data.type === 'plan' && Array.isArray(data.entries)) {
            const lines = data.entries.flatMap((entry) => {
                if (!isObject(entry) || typeof entry.content !== 'string') return []
                const marker = entry.status === 'completed' ? 'x' : ' '
                return [`- [${marker}] ${entry.content}`]
            })
            if (lines.length === 0) return null
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'agent',
                isSidechain: false,
                content: [{ type: 'text', text: `Plan updated:\n${lines.join('\n')}`, uuid: messageId, parentUUID: null }],
                meta
            }
        }

        if (data.type === 'error' && typeof data.message === 'string') {
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'agent',
                isSidechain: false,
                content: [{ type: 'text', text: `Grok error: ${data.message}`, uuid: messageId, parentUUID: null }],
                meta
            }
        }

        if (data.type === 'grok-extension' && typeof data.method === 'string') {
            const display = classifyGrokExtensionForDisplay(data.method, data.params)
            if (display.type === 'hidden') return null
            if (display.type === 'message') {
                return {
                    id: messageId,
                    localId,
                    createdAt,
                    role: 'agent',
                    content: [{ type: 'text', text: display.message, uuid: messageId, parentUUID: null }],
                    isSidechain: false,
                    meta
                }
            }
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'event',
                content: { type: 'grok-extension', method: data.method, params: data.params },
                isSidechain: false,
                meta
            }
        }

        if (data.type === 'moa-reference' && typeof data.message === 'string') {
            const label = asString(data.label) ?? 'reference'
            const index = asNumber(data.index)
            const count = asNumber(data.count)
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'moa-reference',
                    label,
                    text: data.message,
                    ...(index !== null ? { index } : {}),
                    ...(count !== null ? { count } : {}),
                    uuid: messageId,
                    parentUUID: null
                }],
                meta
            }
        }

        if (data.type === 'moa-aggregating') {
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'event',
                content: {
                    type: 'moa-aggregating',
                    ...(asString(data.aggregator) ? { aggregator: asString(data.aggregator) } : {})
                },
                isSidechain: false,
                meta
            }
        }

        if (data.type === 'attachments') {
            const attachments = parseAttachmentMetadata(data.attachments)
            if (attachments.length === 0) return null
            const uuid = asString(data.id) ?? messageId
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'agent',
                isSidechain: false,
                content: [{ type: 'attachments', attachments, uuid, parentUUID: null }],
                meta
            }
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
            const output = isObject(data.output) ? data.output : null
            const isError = data.is_error === true
                || data.isError === true
                || output?.is_error === true
                || output?.isError === true
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
                    is_error: isError,
                    uuid,
                    parentUUID: null
                }],
                meta
            }
        }
    }

    return null
}
