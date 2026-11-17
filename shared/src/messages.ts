import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import { AGENT_MESSAGE_PAYLOAD_TYPE } from './modes'
import { isObject } from './utils'

type RoleWrappedRecord = {
    role: string
    content: unknown
    meta?: unknown
}

const VISIBLE_CLAUDE_SYSTEM_SUBTYPES = new Set([
    'api_error',
    'turn_duration',
    'microcompact_boundary',
    'compact_boundary',
    // Auto-generated recap Claude Code's local TUI writes to the transcript on
    // window blur/focus (5min+ idle). Only observed via the local launcher's
    // transcript scan — SDK/remote mode never emits it. Chat-visible here also
    // means CLI-forwarded, web-rendered, and included in session export
    // (parity with turn_duration / compact_boundary).
    'away_summary'
])

export function isRoleWrappedRecord(value: unknown): value is RoleWrappedRecord {
    if (!isObject(value)) return false
    return typeof value.role === 'string' && 'content' in value
}

export function unwrapRoleWrappedRecordEnvelope(value: unknown): RoleWrappedRecord | null {
    if (isRoleWrappedRecord(value)) return value
    if (!isObject(value)) return null

    const direct = value.message
    if (isRoleWrappedRecord(direct)) return direct

    const data = value.data
    if (isObject(data) && isRoleWrappedRecord(data.message)) return data.message as RoleWrappedRecord

    const payload = value.payload
    if (isObject(payload) && isRoleWrappedRecord(payload.message)) return payload.message as RoleWrappedRecord

    return null
}

export function isClaudeChatVisibleSystemSubtype(subtype: unknown): subtype is string {
    return typeof subtype === 'string' && VISIBLE_CLAUDE_SYSTEM_SUBTYPES.has(subtype)
}

export function isClaudeChatVisibleMessage(message: { type: unknown; subtype?: unknown }): boolean {
    if (message.type === 'rate_limit_event') {
        return false
    }

    if (message.type === 'tool_progress') {
        return false
    }

    if (message.type !== 'system') {
        return true
    }

    return isClaudeChatVisibleSystemSubtype(message.subtype)
}

export function isRedundantGoalStatusMessageText(value: unknown): boolean {
    if (typeof value !== 'string') return false
    const message = value.trim()
    return message === 'Goal cleared'
        || /^Goal (active|paused|complete|blocked|limited by (?:budget|usage))(?:$|\s+·\s+)/.test(message)
}

/**
 * ACP agents stream thoughts one token at a time, so the CLI coalesces them
 * into a buffer and re-sends the whole buffer under a stable stream id every
 * few hundred milliseconds. Every snapshot but the newest is dead weight: the
 * buffer only ever grows, so an older snapshot is a strict prefix of a newer
 * one and the timeline collapses them back into a single block anyway.
 *
 * These two readers let the hub and the web keep one message per stream
 * instead of one per snapshot. They are deliberately separate:
 *
 *  - `getReasoningStreamId` answers "which stream does this belong to" and so
 *    also matches the settled message that closes a stream. That message is
 *    what triggers the final cleanup of its own leftovers.
 *  - `getLiveReasoningStreamId` answers "is this a replaceable snapshot", and
 *    so only ever matches something safe to drop.
 *
 * Anything unrecognised reads as `null`, which means "keep it".
 */
function readReasoningStreamId(value: unknown, liveOnly: boolean): string | null {
    const record = unwrapRoleWrappedRecordEnvelope(value)
    if (record?.role !== 'agent') return null

    const content = record.content
    if (!isObject(content) || content.type !== AGENT_MESSAGE_PAYLOAD_TYPE) return null

    const data = isObject(content.data) ? content.data : null
    if (!data || data.type !== 'reasoning') return null
    if (liveOnly && data.live !== true) return null

    const id = data.id
    if (typeof id !== 'string' || id.trim().length === 0) return null
    return id
}

export function getReasoningStreamId(value: unknown): string | null {
    return readReasoningStreamId(value, false)
}

export function getLiveReasoningStreamId(value: unknown): string | null {
    return readReasoningStreamId(value, true)
}

/**
 * The callId of a supersedable tool-call row, or `null` when the value is not
 * one.
 *
 * ACP agents re-emit the same tool call under a stable callId on every state
 * tick, and the timeline folds all of those rows into a single card. The hub
 * and the web therefore keep only the latest row per callId, and both need to
 * recognise the rows that may be superseded. Only `tool-call` payloads match:
 * the `tool-call-result` that shares the callId is a distinct row that carries
 * completion, so it is never dropped. Anything unrecognised reads as `null`,
 * which means "keep it".
 */
export function getToolCallId(value: unknown): string | null {
    const record = unwrapRoleWrappedRecordEnvelope(value)
    if (record?.role !== 'agent') return null

    const content = record.content
    if (!isObject(content) || content.type !== AGENT_MESSAGE_PAYLOAD_TYPE) return null

    const data = isObject(content.data) ? content.data : null
    if (!data || data.type !== 'tool-call') return null

    const callId = data.callId
    if (typeof callId !== 'string' || callId.trim().length === 0) return null
    return callId
}

export function isRedundantGoalStatusEventContent(value: unknown): boolean {
    const record = unwrapRoleWrappedRecordEnvelope(value)
    if (record?.role !== 'agent') return false

    const eventContent = record.content
    if (!isObject(eventContent) || eventContent.type !== 'event') return false

    const data = isObject(eventContent.data) ? eventContent.data : null
    if (!data || data.type !== 'message') return false

    return isRedundantGoalStatusMessageText(data.message)
}

/**
 * Best-effort plain-text extraction from a stored agent message's `content`.
 *
 * Two structural shapes are common in this fork:
 *
 *  1. `codex` flavor:  content.type = 'codex',  content.data.type = 'message'
 *     -> assistant text at `content.data.message` (string).
 *
 *  2. `output` flavor (Claude SDK passthrough):  content.type = 'output',
 *     content.data.type = 'assistant'  -> text at
 *     `content.data.message.content[i].text` (array of `{type:'text', text}`).
 *
 * Returns `null` when the content does not look like assistant *text*
 * (tool calls, tool results, reasoning, token counts, etc.) so callers can
 * skip those messages and fall back to the previous one.
 */
export function extractAssistantPlainText(content: unknown): string | null {
    if (!isObject(content)) return null

    if (content.type === 'codex') {
        const data = isObject(content.data) ? content.data : null
        if (!data || data.type !== 'message') return null
        return typeof data.message === 'string' && data.message.length > 0
            ? data.message
            : null
    }

    if (content.type === 'output') {
        const data = isObject(content.data) ? content.data : null
        if (!data) return null

        // AGY planner prose (cli wraps PLANNER_RESPONSE as agy_message).
        if (data.type === 'agy_message') {
            return typeof data.content === 'string' && data.content.trim().length > 0
                ? data.content
                : null
        }

        if (data.type !== 'assistant') return null
        const message = isObject(data.message) ? data.message : null
        if (typeof data.message === 'string' && data.message.trim().length > 0) {
            return data.message
        }
        // Claude also sends assistant prose as a plain string `message.content`
        // (the renderer handles this shape in normalizeAgent). Without this the
        // reply is visible but absent from both backfill and live indexing.
        if (typeof message?.content === 'string') {
            return message.content.trim().length > 0 ? message.content : null
        }
        const blocks = Array.isArray(message?.content) ? message.content : null
        if (!blocks) return null
        const textParts: string[] = []
        for (const block of blocks) {
            if (!isObject(block)) continue
            if (block.type === 'text' && typeof block.text === 'string') {
                textParts.push(block.text)
            }
        }
        if (textParts.length === 0) return null
        return textParts.join('\n')
    }

    return null
}

// AGY sometimes echoes an async task's raw result into its own PLANNER_RESPONSE
// prose. The web renderer strips this block and renders the corresponding task
// result separately, so keep it out of the searchable assistant text as well.
export function stripAgyEchoedTaskResult(text: string): string {
    return text.replace(/\n*\[Message\]\s+timestamp=[\s\S]*$/, '').trim()
}

// AGY's transitional task-log narration is rendered as a compact tool chip,
// not an assistant text bubble. Return its task number for renderer/index parity.
export function getAgyTaskLogId(text: string): string | null {
    return text.match(/^Inside the task-(\d+) log\b/)?.[1] ?? null
}

function normalizeSearchablePlainText(value: string): string | null {
    const text = value.trim().replace(/\s+/g, ' ')
    return text.length > 0 ? text : null
}

type BoundedText = {
    text: string
    truncated: boolean
}

type BoundedTextChunks = {
    chunks: string[]
    truncated: boolean
}

function sliceJoinedText(
    parts: readonly string[],
    separator: string,
    start: number,
    length: number
): string {
    if (length <= 0) return ''

    const end = start + length
    const chunks: string[] = []
    let offset = 0
    for (let index = 0; index < parts.length; index++) {
        const part = parts[index]!
        const partStart = offset
        const partEnd = partStart + part.length
        if (partEnd > start && partStart < end) {
            chunks.push(part.slice(
                Math.max(0, start - partStart),
                Math.min(part.length, end - partStart)
            ))
        }
        offset = partEnd

        if (index === parts.length - 1) break
        const separatorStart = offset
        const separatorEnd = separatorStart + separator.length
        if (separatorEnd > start && separatorStart < end) {
            chunks.push(separator.slice(
                Math.max(0, start - separatorStart),
                Math.min(separator.length, end - separatorStart)
            ))
        }
        offset = separatorEnd
        if (offset >= end) break
    }
    return chunks.join('')
}

/**
 * Join only the bounded head and tail of a multi-part message. In particular,
 * do not materialize a potentially unbounded structured prompt before the
 * Markdown parser's source limit is applied.
 */
function collectJoinedHeadTail(
    parts: readonly string[],
    separator: string,
    maxSourceCharacters: number
): BoundedTextChunks {
    if (parts.length === 0) return { chunks: [], truncated: false }
    if (!Number.isFinite(maxSourceCharacters)) {
        return { chunks: [parts.join(separator)], truncated: false }
    }

    const maxCharacters = Math.max(0, Math.floor(maxSourceCharacters))
    if (maxCharacters === 0) return { chunks: [], truncated: parts.length > 0 }

    let totalCharacters = 0
    for (let index = 0; index < parts.length; index++) {
        totalCharacters += parts[index]!.length
        if (index > 0) totalCharacters += separator.length
    }
    if (totalCharacters <= maxCharacters) {
        return { chunks: [parts.join(separator)], truncated: false }
    }

    if (maxCharacters <= separator.length) {
        return {
            chunks: [sliceJoinedText(parts, separator, 0, maxCharacters)],
            truncated: true
        }
    }

    const contentCharacters = maxCharacters - separator.length
    const headCharacters = Math.ceil(contentCharacters / 2)
    const tailCharacters = contentCharacters - headCharacters
    const chunks = [sliceJoinedText(parts, separator, 0, headCharacters)]
    if (tailCharacters > 0) {
        chunks.push(sliceJoinedText(parts, separator, totalCharacters - tailCharacters, tailCharacters))
    }
    return { chunks, truncated: true }
}

function normalizeSearchableMarkdownChunks(chunks: readonly string[]): string | null {
    const markdownBlockTypes = new Set([
        'blockquote',
        'code',
        'heading',
        'html',
        'list',
        'listItem',
        'paragraph',
        'root',
        'table',
        'tableCell',
        'tableRow'
    ])
    const renderMarkdownNode = (node: {
        type?: string
        value?: string
        children?: readonly unknown[]
    }): string => {
        if (node.type === 'break') return ' '
        // The chat renderer drops raw HTML, so indexing node.value here would
        // make an HTML comment searchable and surface it in snippets with no
        // rendered text to highlight.
        if (node.type === 'html') return ''
        if (typeof node.value === 'string') return node.value

        let rendered = ''
        let previousType: string | undefined
        for (const child of node.children ?? []) {
            if (!isObject(child)) continue
            const childText = renderMarkdownNode(child)
            if (!childText) continue
            if (
                rendered
                && (markdownBlockTypes.has(child.type as string) || markdownBlockTypes.has(previousType ?? ''))
            ) {
                rendered += ' '
            }
            rendered += childText
            previousType = child.type as string | undefined
        }
        return rendered
    }

    const rendered = chunks.map((chunk) => {
        try {
            // The chat renders with remark-gfm, so parse the same dialect:
            // without it `~~old~~` keeps its tildes and a search for the
            // displayed phrase cannot match, and table pipes stay in the index.
            return renderMarkdownNode(fromMarkdown(chunk, {
                extensions: [gfm({ singleTilde: false })],
                mdastExtensions: [gfmFromMarkdown()]
            }))
        } catch {
            // Keep indexing malformed/incomplete streamed Markdown rather than
            // dropping otherwise visible assistant text.
            return chunk
        }
    }).join(' ')
    return normalizeSearchablePlainText(rendered)
}

function normalizeSearchableMarkdownTextWithMetadata(
    value: string,
    maxSourceCharacters = Number.POSITIVE_INFINITY
): BoundedText | null {
    const bounded = collectJoinedHeadTail([value], ' ', maxSourceCharacters)
    const text = normalizeSearchableMarkdownChunks(bounded.chunks)
    return text ? { text, truncated: bounded.truncated } : null
}

function extractUserPlainTextWithMetadata(
    content: unknown,
    maxSourceCharacters = Number.POSITIVE_INFINITY
): BoundedText | null {
    if (typeof content === 'string') {
        return normalizeSearchableMarkdownTextWithMetadata(content, maxSourceCharacters)
    }

    const blocks = Array.isArray(content) ? content : [content]
    const textParts = blocks
        .map((block) => {
            if (!isObject(block) || block.type !== 'text' || typeof block.text !== 'string') {
                return null
            }
            return block.text
        })
        .filter((text): text is string => text !== null)

    const bounded = collectJoinedHeadTail(textParts, ' ', maxSourceCharacters)
    const text = normalizeSearchableMarkdownChunks(bounded.chunks)
    return text ? { text, truncated: bounded.truncated } : null
}

export function extractUserPlainText(content: unknown, maxSourceCharacters = Number.POSITIVE_INFINITY): string | null {
    return extractUserPlainTextWithMetadata(content, maxSourceCharacters)?.text ?? null
}

function extractClaudeUserPlainText(content: unknown, maxSourceCharacters = Number.POSITIVE_INFINITY): BoundedText | null {
    if (!isObject(content) || content.type !== 'output') return null
    const data = isObject(content.data) ? content.data : null
    if (!data || data.type !== 'user' || Boolean(data.isSidechain)) return null

    const message = isObject(data.message) ? data.message : null
    const blocks = Array.isArray(message?.content) ? message.content : null
    if (!blocks || blocks.length === 0) return null

    return extractUserPlainTextWithMetadata(blocks, maxSourceCharacters)
}

export type SearchableMessageContext = {
    injectedTurnUuids?: ReadonlySet<string>
    maxSourceCharacters?: number
}

/** Return the Claude UUID that identifies a system-injected user turn. */
export function extractInjectedTurnUuid(value: unknown): string | null {
    const record = unwrapRoleWrappedRecordEnvelope(value)
    if (!record || record.role !== 'agent' || !isObject(record.content) || record.content.type !== 'output') {
        return null
    }
    const data = isObject(record.content.data) ? record.content.data : null
    if (!data || data.type !== 'user') return null
    const message = isObject(data.message) ? data.message : null
    const messageContent = message?.content
    const isSystemInjected = Boolean(data.isSidechain) || typeof messageContent === 'string'
    if (!isSystemInjected || typeof data.uuid !== 'string' || data.uuid.length === 0) return null
    return data.uuid
}

export function extractAssistantParentUuid(content: unknown): string | null {
    if (!isObject(content) || content.type !== 'output') return null
    const data = isObject(content.data) ? content.data : null
    return data?.type === 'assistant' && typeof data.parentUuid === 'string' && data.parentUuid.length > 0
        ? data.parentUuid
        : null
}

function isNoResponseRequestedText(text: string): boolean {
    const trimmed = text.trim()
    return trimmed === 'No response requested.' || trimmed === 'No response requested'
}

function extractSearchableAssistantPlainText(
    content: unknown,
    context?: SearchableMessageContext
): BoundedText | null {
    if (!isObject(content) || content.type !== 'output') {
        const text = extractAssistantPlainText(content)
        return text === null ? null : { text, truncated: false }
    }

    const data = isObject(content.data) ? content.data : null
    if (!data || data.type !== 'assistant') {
        const text = extractAssistantPlainText(content)
        return text === null ? null : { text, truncated: false }
    }

    const message = isObject(data.message) ? data.message : null
    const blocks = Array.isArray(message?.content) ? message.content : null
    // String `message.content` runs through the same sentinel filtering and
    // bounding as block text; the plain-text fallback below is unbounded.
    const stringContent = !blocks && typeof message?.content === 'string'
        ? message.content
        : null
    if (!blocks && stringContent === null) {
        const text = extractAssistantPlainText(content)
        return text === null ? null : { text, truncated: false }
    }

    const taskToolCall = blocks?.find((block) => {
        if (!isObject(block) || block.type !== 'tool_use') return false
        const name = typeof block.name === 'string' ? block.name : ''
        return name === 'Task'
            || name === 'Agent'
            || name.startsWith('Task:')
            || name.startsWith('Agent:')
    })
    const taskToolInput = isObject(taskToolCall) && isObject(taskToolCall.input)
        ? taskToolCall.input
        : null
    const hiddenTaskPrompt = typeof taskToolInput?.prompt === 'string'
        ? taskToolInput.prompt.trim()
        : null
    const textParts = blocks
        ? blocks.flatMap((block) => {
            if (!isObject(block) || block.type !== 'text' || typeof block.text !== 'string') return []
            return hiddenTaskPrompt && block.text.trim() === hiddenTaskPrompt ? [] : [block.text]
        })
        : stringContent !== null && stringContent.trim().length > 0
            ? [stringContent]
            : []
    if (textParts.length === 1) {
        const parentUuid = extractAssistantParentUuid(content)
        if (
            parentUuid
            && context?.injectedTurnUuids?.has(parentUuid)
            && isNoResponseRequestedText(textParts[0]!)
        ) {
            return null
        }
    }
    if (textParts.length === 0) return null
    const bounded = collectJoinedHeadTail(
        textParts,
        '\n',
        context?.maxSourceCharacters ?? Number.POSITIVE_INFINITY
    )
    return bounded.chunks.length > 0
        ? { text: bounded.chunks.join('\n'), truncated: bounded.truncated }
        : null
}

export type SearchableMessage = {
    role: 'user' | 'assistant'
    text: string
    /** Stable renderer identity used to coalesce streamed assistant snapshots. */
    renderKey?: string
    /** True when the source text exceeded the indexing budget and was bounded. */
    truncated?: boolean
}

function getMessageRenderKey(content: unknown): string | undefined {
    if (!isObject(content)) return undefined

    if (content.type === 'codex') {
        const data = isObject(content.data) ? content.data : null
        if (data?.type === 'message' && typeof data.id === 'string' && data.id.length > 0) {
            return data.id
        }
    }

    if (content.type === 'text' && typeof content.streamId === 'string' && content.streamId.length > 0) {
        return content.streamId
    }

    return undefined
}

/** Return the renderer identity for a visible message, even when it has no text. */
export function extractMessageRenderKey(value: unknown): string | null {
    const record = unwrapRoleWrappedRecordEnvelope(value)
    if (!record || (record.role !== 'agent' && record.role !== 'assistant')) return null
    return getMessageRenderKey(record.content) ?? null
}

/** Return whether a message is a cumulative live stream snapshot. */
export function isLiveStreamSnapshot(value: unknown): boolean {
    const record = unwrapRoleWrappedRecordEnvelope(value)
    if (!record || (record.role !== 'agent' && record.role !== 'assistant')) return false
    if (!isObject(record.content)) return false

    if (record.content.type === 'codex') {
        const data = isObject(record.content.data) ? record.content.data : null
        return data?.type === 'message' && data.streamSnapshot === true && data.live === true
    }

    return record.content.type === 'text'
        && record.content.streamSnapshot === true
        && record.content.live === true
}

function isHiddenAssistantOutput(content: unknown): boolean {
    if (!isObject(content) || content.type !== 'output') return false
    const data = isObject(content.data) ? content.data : null
    return Boolean(data?.isMeta) || Boolean(data?.isCompactSummary) || Boolean(data?.isSidechain)
}

/** Extract only user-visible user/assistant prose from a stored role envelope. */
export function extractSearchableMessageText(
    value: unknown,
    context?: SearchableMessageContext
): SearchableMessage | null {
    const record = unwrapRoleWrappedRecordEnvelope(value)
    if (!record) return null

    if (record.role === 'user') {
        const extracted = extractUserPlainTextWithMetadata(record.content, context?.maxSourceCharacters)
        return extracted
            ? {
                role: 'user',
                text: extracted.text,
                ...(extracted.truncated ? { truncated: true } : {})
            }
            : null
    }

    if (record.role === 'agent' || record.role === 'assistant') {
        if (isHiddenAssistantOutput(record.content)) return null
        const claudeUserText = extractClaudeUserPlainText(record.content, context?.maxSourceCharacters)
        if (claudeUserText) {
            return {
                role: 'user',
                text: claudeUserText.text,
                ...(claudeUserText.truncated ? { truncated: true } : {})
            }
        }
        const renderKey = getMessageRenderKey(record.content)
        const isAgyPlannerMessage = isObject(record.content)
            && record.content.type === 'output'
            && isObject(record.content.data)
            && record.content.data.type === 'agy_message'
        const directText = typeof record.content === 'string'
            ? record.content
            : isObject(record.content)
                && record.content.type === 'text'
                && typeof record.content.text === 'string'
                ? record.content.text
                : null
        const extracted = isAgyPlannerMessage
            ? (() => {
                const text = directText ?? extractAssistantPlainText(record.content)
                return text === null ? null : { text, truncated: false }
            })()
            : directText !== null
                ? { text: directText, truncated: false }
                : extractSearchableAssistantPlainText(record.content, context)
        if (!extracted) return null

        const rawText = stripNotifySummaryFooter(
            isAgyPlannerMessage
                ? stripAgyEchoedTaskResult(extracted.text)
                : extracted.text
        )
        const normalized = normalizeSearchableMarkdownTextWithMetadata(
            rawText,
            context?.maxSourceCharacters
        )
        if (!normalized || (isAgyPlannerMessage && getAgyTaskLogId(normalizeSearchablePlainText(rawText) ?? ''))) return null
        const truncated = extracted.truncated || normalized.truncated
        return {
            role: 'assistant',
            text: normalized.text,
            ...(renderKey ? { renderKey } : {}),
            ...(truncated ? { truncated: true } : {})
        }
    }

    return null
}

/** Output a reader can consume. Bookkeeping, reasoning and tool traffic do not
 * create unread activity. Run at durable ingest, never on heartbeat/metadata. */
export function hasUnreadMessageContent(value: unknown): boolean {
    const record = unwrapRoleWrappedRecordEnvelope(value)
    if (record?.role !== 'agent' || !isObject(record.content)) return false
    const content = record.content
    if (isRedundantGoalStatusEventContent(value)) return false
    const data = isObject(content.data) ? content.data : null
    if (!data) return false
    if (content.type === 'output' && (data.isMeta || data.isCompactSummary
        || !isClaudeChatVisibleMessage({ type: data.type, subtype: data.subtype }))) return false
    if (extractAssistantPlainText(content)?.trim()) return true
    if (content.type === 'output') {
        if (data.type === 'assistant' && typeof data.error === 'string' && data.error.trim()) return true
        if (data.type === 'assistant' && isObject(data.message) && typeof data.message.content === 'string') {
            return data.message.content.trim().length > 0
        }
        if (data.type === 'result') return data.is_error === true || (typeof data.result === 'string' && data.result.trim().length > 0)
        return data.type === 'system' && data.subtype === 'api_error'
    }
    if (content.type === AGENT_MESSAGE_PAYLOAD_TYPE) {
        if (data.type === 'error') return typeof data.message === 'string' && data.message.trim().length > 0
        if (data.type === 'generated-image') {
            const id = data.imageId ?? data.image_id
            return typeof id === 'string' && id.trim().length > 0
        }
    }
    return false
}

function hasConversationBlock(value: unknown): boolean {
    if (typeof value === 'string') return value.trim().length > 0
    if (Array.isArray(value)) return value.some(hasConversationBlock)
    if (!isObject(value)) return false
    if (value.type === 'text') {
        return hasConversationBlock(value.text)
            || (Array.isArray(value.attachments) && value.attachments.length > 0)
    }
    if (value.type === 'thinking') return hasConversationBlock(value.thinking)
    if (value.type === 'image' || value.type === 'document') return isObject(value.source)
    if (value.type === 'tool_use') return typeof value.name === 'string' && value.name.trim().length > 0
    if (value.type === 'tool_result') return hasConversationBlock(value.content)
    return false
}

/** Conversation payloads, not launch/status/usage events or display titles. */
export function hasConversationMessageContent(value: unknown): boolean {
    const record = unwrapRoleWrappedRecordEnvelope(value)
    if (record?.role === 'user') return hasConversationBlock(record.content)
    if (record?.role !== 'agent' || !isObject(record.content)) return false
    const content = record.content
    if (extractAssistantPlainText(content)?.trim()) return true
    const data = isObject(content.data) ? content.data : null
    if (!data) return false
    if (content.type === 'output') {
        if (data.type === 'assistant' || data.type === 'user') {
            return isObject(data.message) && hasConversationBlock(data.message.content)
        }
        return data.type === 'agy_tool_action' && hasConversationBlock(data.content)
    }
    if (content.type === 'event') {
        return data.type === 'compact-summary' && hasConversationBlock(data.summary)
    }
    if (content.type !== AGENT_MESSAGE_PAYLOAD_TYPE) return false
    if (data.type === 'reasoning') return hasConversationBlock(data.message)
    if (data.type === 'compact-summary') return hasConversationBlock(data.summary)
    if (data.type === 'tool-call' || data.type === 'tool-call-result') {
        return typeof data.callId === 'string' && data.callId.trim().length > 0
    }
    if (data.type === 'generated-image') return hasConversationBlock(data.imageId ?? data.image_id)
    if (data.type === 'plan' || data.type === 'plan_update') {
        const entries = data.entries ?? data.plan ?? data.update ?? data.items ?? data.steps
        return Array.isArray(entries) && entries.length > 0
    }
    return false
}

const NOTIFY_SUMMARY_PREFIX = 'AGENT_NOTIFY_SUMMARY '

export type NotifySummary = {
    version?: number
    agent?: string
    project?: string
    status?: string
    action?: string
    summary?: string
}

/**
 * Match a well-formed `AGENT_NOTIFY_SUMMARY {...}` footer on a single line.
 *
 * Allows an optional *glued* prose prefix on the same line (agents sometimes
 * omit the newline: `Done.AGENT_NOTIFY_SUMMARY {...}`). Whitespace-delimited
 * mentions (`Example: AGENT_NOTIFY_SUMMARY {...}`) are not treated as footers.
 * Scans left-to-right and returns the first token occurrence whose remainder
 * is valid JSON through end of line - so a literal `AGENT_NOTIFY_SUMMARY `
 * inside a JSON string value does not steal the match from the real footer.
 */
type NotifySummaryLineMatch = {
    jsonPart: string
    start: number
}

/**
 * Token offsets on a line that are positionally eligible to start a footer.
 *
 * Shared by the strict matcher and near-miss detection so both agree on what
 * counts as an *attempted* footer regardless of whether the payload parses.
 */
function eligibleTokenStarts(line: string): number[] {
    const starts: number[] = []
    for (
        let idx = line.indexOf(NOTIFY_SUMMARY_PREFIX);
        idx >= 0;
        idx = line.indexOf(NOTIFY_SUMMARY_PREFIX, idx + NOTIFY_SUMMARY_PREFIX.length)
    ) {
        // Keep glued footers (`Done.AGENT_NOTIFY_SUMMARY ...`) and indented
        // standalone footers, but reject ordinary prose-delimited mentions
        // (`Example: AGENT_NOTIFY_SUMMARY ...`).
        const prefix = line.slice(0, idx)
        if (prefix.trim().length > 0 && /\s/.test(line[idx - 1]!)) continue
        starts.push(idx)
    }
    return starts
}

function matchNotifySummaryLine(line: string): NotifySummaryLineMatch | null {
    for (const idx of eligibleTokenStarts(line)) {
        const jsonPart = line.slice(idx + NOTIFY_SUMMARY_PREFIX.length).trim()
        if (!jsonPart.startsWith('{') || !jsonPart.endsWith('}')) continue
        try {
            if (isObject(JSON.parse(jsonPart))) return { jsonPart, start: idx }
        } catch {
            // Try the next occurrence (e.g. token mentioned inside a value).
        }
    }
    return null
}

function parseNotifySummaryJson(jsonPart: string): NotifySummary | null {
    try {
        const parsed: unknown = JSON.parse(jsonPart)
        if (!isObject(parsed)) return null
        const result: NotifySummary = {}
        if (typeof parsed.version === 'number') result.version = parsed.version
        if (typeof parsed.agent === 'string') result.agent = parsed.agent
        if (typeof parsed.project === 'string') result.project = parsed.project
        if (typeof parsed.status === 'string') result.status = parsed.status
        if (typeof parsed.action === 'string') result.action = parsed.action
        if (typeof parsed.summary === 'string') result.summary = parsed.summary
        return result
    } catch {
        return null
    }
}

type LastLine = {
    lines: string[]
    lastIdx: number
    line: string
}

/** The footer anchor: last non-empty line, trailing whitespace removed. */
function lastNonEmptyLine(text: string): LastLine | null {
    const lines = text.split('\n')
    let lastIdx = lines.length - 1
    while (lastIdx >= 0 && lines[lastIdx].trim() === '') lastIdx -= 1
    if (lastIdx < 0) return null

    return { lines, lastIdx, line: lines[lastIdx].trimEnd() }
}

/** Everything the reader should still see once the footer at `start` is removed. */
function visibleTextBefore(last: LastLine, start: number): string {
    const prefix = last.line.slice(0, start).trimEnd()
    const visibleLines = last.lines.slice(0, last.lastIdx)
    if (prefix.length > 0) visibleLines.push(prefix)
    return visibleLines.join('\n').trimEnd()
}

type NotifySummaryMatch = {
    lines: string[]
    lastIdx: number
    line: string
    match: NotifySummaryLineMatch
    summary: NotifySummary
}

function findNotifySummary(text: string): NotifySummaryMatch | null {
    const last = lastNonEmptyLine(text)
    if (last === null) return null

    const match = matchNotifySummaryLine(last.line)
    if (match === null) return null

    const summary = parseNotifySummaryJson(match.jsonPart)
    if (summary === null) return null

    return { ...last, match, summary }
}

/** Why an attempted footer failed to parse. */
export type NotifySummaryNearMissReason =
    /** Opens `{` but never closes - the usual shape of a truncated turn. */
    | 'unterminated-json'
    /** A complete JSON object followed by extra text on the same line. */
    | 'trailing-content'
    /** Balanced braces that JSON.parse rejects. */
    | 'invalid-json'
    /** The payload is not a JSON object at all. */
    | 'not-an-object'

export type NotifySummaryNearMiss = {
    reason: NotifySummaryNearMissReason
    /**
     * Payload size only. Callers log near misses, and the payload is agent
     * output - the reason plus the message id is enough to triage one without
     * copying session content into a log.
     */
    payloadLength: number
}

/** Index just past the `}` closing the JSON object at the start of `text`, or -1. */
function jsonObjectEnd(text: string): number {
    let depth = 0
    let inString = false
    let escaped = false
    for (let idx = 0; idx < text.length; idx += 1) {
        const char = text[idx]
        if (inString) {
            if (escaped) escaped = false
            else if (char === '\\') escaped = true
            else if (char === '"') inString = false
            continue
        }
        if (char === '"') inString = true
        else if (char === '{') depth += 1
        else if (char === '}') {
            depth -= 1
            if (depth === 0) return idx + 1
        }
    }
    return -1
}

function classifyNearMiss(jsonPart: string): NotifySummaryNearMissReason {
    if (!jsonPart.startsWith('{')) return 'not-an-object'
    const end = jsonObjectEnd(jsonPart)
    if (end < 0) return 'unterminated-json'
    if (jsonPart.slice(end).trim().length > 0) return 'trailing-content'
    return 'invalid-json'
}

type NearMissMatch = NotifySummaryNearMiss & { start: number }

function matchNearMissLine(line: string): NearMissMatch | null {
    if (matchNotifySummaryLine(line) !== null) return null

    for (const start of eligibleTokenStarts(line)) {
        const jsonPart = line.slice(start + NOTIFY_SUMMARY_PREFIX.length).trim()
        // A bare token with no payload is prose, not an attempted footer.
        if (jsonPart.length === 0) continue
        return { start, reason: classifyNearMiss(jsonPart), payloadLength: jsonPart.length }
    }
    return null
}

/**
 * Report a *near miss*: the last non-empty line attempts the footer but yields
 * no summary, so `extractNotifySummary` drops the turn's status.
 *
 * Eligibility is identical to the strict matcher - a whitespace-delimited prose
 * mention (`Example: AGENT_NOTIFY_SUMMARY {...`) is never a near miss, and a
 * well-formed footer never is either. Intended for a warn-level diagnostic at
 * the ingest boundary so a broken emitter is greppable instead of invisible.
 */
export function detectNotifySummaryNearMiss(text: unknown): NotifySummaryNearMiss | null {
    if (typeof text !== 'string' || text.length === 0) return null

    const last = lastNonEmptyLine(text)
    if (last === null) return null

    const match = matchNearMissLine(last.line)
    if (match === null) return null

    return { reason: match.reason, payloadLength: match.payloadLength }
}

/**
 * Look for an `AGENT_NOTIFY_SUMMARY {...json...}` footer as the **last
 * non-empty line** of an agent's plain-text message.
 *
 * End-anchor: trailing blank lines are fine, but prose on a later
 * non-empty line is non-compliant and returns null. Mid-body quotes of
 * the token are ignored for the same reason. An optional *glued* prose prefix
 * on the last line itself is tolerated (`Done.AGENT_NOTIFY_SUMMARY {…}`);
 * whitespace-delimited examples on that line are not.
 *
 * Returns the parsed object on success, `null` on any deviation. The
 * shape is intentionally loose - we only trust `summary`, `action`, and
 * `status` for notification rendering, but the full object is forwarded
 * onto the meta-event bus when Phase 2 lands.
 */
export function extractNotifySummary(text: unknown): NotifySummary | null {
    if (typeof text !== 'string' || text.length === 0) return null

    return findNotifySummary(text)?.summary ?? null
}

export type NotifySummaryDisplay = {
    /** Agent prose with the machine-readable footer removed. */
    visibleText: string
    summary: NotifySummary
}

/**
 * Split a valid trailing summary footer into user-facing prose and metadata.
 *
 * The original message remains untouched; callers can use `visibleText` only
 * for presentation while retaining the raw text for copy/export/notifications.
 */
export function splitNotifySummary(text: unknown): NotifySummaryDisplay | null {
    if (typeof text !== 'string' || text.length === 0) return null

    const found = findNotifySummary(text)
    if (found === null) return null

    return {
        visibleText: visibleTextBefore(found, found.match.start),
        summary: found.summary
    }
}

/**
 * The near misses that are safe to delete: those whose payload region runs to
 * the end of the line.
 *
 * Truncation terminates the line by definition - that is what truncation is -
 * so every shape this feature exists to catch lands here, as do payloads that
 * are malformed all the way to end of line (`{bogus}`, `not-json`).
 *
 * `trailing-content` is the opposite shape: a complete JSON object with text
 * after it on the same line. That is what a quoted example looks like -
 * ``Use `AGENT_NOTIFY_SUMMARY {...}` at the end.`` - and no enumeration of
 * quoting syntax is needed to recognise it, because an example always closes
 * its delimiter *after* the payload and a truncated footer never does. Those
 * lines stay visible.
 *
 * The cost is one odd line on screen when an emitter genuinely does append
 * stray text after a complete object. The status is dropped either way, since
 * the strict matcher rejects that shape too, so the only change is cosmetic.
 * The alternative is deleting a reader's example and the prose around it - and
 * the Codex commentary path strips before storage rather than before display,
 * so that loss is permanent. Showing a strange line beats destroying text.
 */
function strippableNearMissStart(line: string): number | undefined {
    const near = matchNearMissLine(line)
    if (near === null || near.reason === 'trailing-content') return undefined
    return near.start
}

/**
 * Render/copy helper: remove a trailing AGENT_NOTIFY_SUMMARY footer.
 *
 * Also removes a *near miss* whose payload runs to end of line - a truncated
 * or malformed final line that attempts the footer (see
 * `detectNotifySummaryNearMiss` and `strippableNearMissStart`). The machine
 * line is addressed to the harness, not the reader, and a truncated one is no
 * more readable than a valid one; dropping the status is bad enough without
 * also leaking the raw token into the transcript.
 *
 * Mid-body mentions, non-final footers, whitespace-delimited prose examples,
 * and quoted examples are still left untouched. Store and parse/FCM paths must
 * keep using the raw text.
 */
export function stripNotifySummaryFooter(text: string): string {
    if (typeof text !== 'string' || text.length === 0) return text

    const last = lastNonEmptyLine(text)
    if (last === null) return text

    const start = matchNotifySummaryLine(last.line)?.start ?? strippableNearMissStart(last.line)
    if (start === undefined) return text

    return visibleTextBefore(last, start)
}

export type { RoleWrappedRecord }
