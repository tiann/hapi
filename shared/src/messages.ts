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
 *  3. Agent event messages:  content.type = 'event',
 *     content.data.type = 'message'  -> status text at
 *     `content.data.message` (string). These remain extractable for chat
 *     rendering, but are not reply-clock candidates.
 *
 * Returns `null` when the content does not look like assistant *text*
 * (tool calls, tool results, reasoning, token counts, etc.) so callers can
 * skip those messages and fall back to the previous one.
 */
export function extractAssistantPlainText(content: unknown): string | null {
    if (!isObject(content)) return null

    if (content.type === 'codex' || content.type === 'event') {
        const data = isObject(content.data) ? content.data : null
        if (!data || data.type !== 'message') return null
        return typeof data.message === 'string' && data.message.trim().length > 0
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

/**
 * Whether a stored role-wrapped message contains visible assistant prose.
 *
 * This deliberately shares the same extraction rules as notifications: tool
 * calls, tool results, reasoning, and other agent events must not move the
 * sidebar's "last reply" clock.
 */
export function isAssistantTextMessage(content: unknown): boolean {
    const record = unwrapRoleWrappedRecordEnvelope(content)
    if (record?.role !== 'agent') return false

    const messageContent = record.content

    // `event/message` is a status-event family (for example, model changes
    // and compaction notices), not a main-agent prose reply.
    if (isObject(messageContent) && messageContent.type === 'event') return false

    const outputData = isObject(messageContent) && messageContent.type === 'output'
        && isObject(messageContent.data)
        ? messageContent.data
        : null
    if (isObject(messageContent) && messageContent.type === 'output') {
        if (
            !outputData
            || outputData.isSidechain === true
            || Boolean(outputData.isMeta)
            || Boolean(outputData.isCompactSummary)
        ) return false
        if (!isClaudeChatVisibleMessage({ type: outputData.type, subtype: outputData.subtype })) return false
    }

    const text = extractAssistantPlainText(messageContent)
    if (!text) return false

    // The footer is machine metadata hidden by default in the chat. A footer
    // alone is not an assistant reply, while prose followed by a footer is.
    const visibleText = stripNotifySummaryFooter(text).trim()
    if (!visibleText) return false

    // AGY's task-log narration is rendered as a tool chip; the actual result
    // arrives separately as a background-task card.
    if (outputData?.type === 'agy_message' && /^Inside the task-\d+ log\b/.test(visibleText)) {
        return false
    }

    return true
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

function matchNotifySummaryLine(line: string): NotifySummaryLineMatch | null {
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

type NotifySummaryMatch = {
    lines: string[]
    lastIdx: number
    line: string
    match: NotifySummaryLineMatch
    summary: NotifySummary
}

function findNotifySummary(text: string): NotifySummaryMatch | null {
    const lines = text.split('\n')
    let lastIdx = lines.length - 1
    while (lastIdx >= 0 && lines[lastIdx].trim() === '') lastIdx -= 1
    if (lastIdx < 0) return null

    const line = lines[lastIdx].trimEnd()
    const match = matchNotifySummaryLine(line)
    if (match === null) return null

    const summary = parseNotifySummaryJson(match.jsonPart)
    if (summary === null) return null

    return { lines, lastIdx, line, match, summary }
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

    const prefix = found.line.slice(0, found.match.start).trimEnd()
    const visibleLines = found.lines.slice(0, found.lastIdx)
    if (prefix.length > 0) visibleLines.push(prefix)

    return {
        visibleText: visibleLines.join('\n').trimEnd(),
        summary: found.summary
    }
}

/**
 * Render/copy helper: remove a valid trailing AGENT_NOTIFY_SUMMARY footer.
 * Leaves malformed, mid-body, and non-final occurrences unchanged. Store and
 * parse/FCM paths must keep using the raw text.
 */
export function stripNotifySummaryFooter(text: string): string {
    if (typeof text !== 'string' || text.length === 0) return text
    return splitNotifySummary(text)?.visibleText ?? text
}

export type { RoleWrappedRecord }
