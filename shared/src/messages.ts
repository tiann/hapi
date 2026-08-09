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
        || /^Goal (active|paused|complete|limited by budget)(?:$|\s+·\s+)/.test(message)
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
 * Allows an optional prose prefix on the same line (agents sometimes glue
 * trailing text and the token without a newline). Scans left-to-right and
 * returns the first token occurrence whose remainder is valid JSON through
 * end of line - so a literal `AGENT_NOTIFY_SUMMARY ` inside a JSON string
 * value does not steal the match from the real footer.
 */
function matchNotifySummaryLine(line: string): string | null {
    for (
        let idx = line.indexOf(NOTIFY_SUMMARY_PREFIX);
        idx >= 0;
        idx = line.indexOf(NOTIFY_SUMMARY_PREFIX, idx + NOTIFY_SUMMARY_PREFIX.length)
    ) {
        const jsonPart = line.slice(idx + NOTIFY_SUMMARY_PREFIX.length).trim()
        if (!jsonPart.startsWith('{') || !jsonPart.endsWith('}')) continue
        try {
            if (isObject(JSON.parse(jsonPart))) return jsonPart
        } catch {
            // Try the next occurrence (e.g. token mentioned inside a value).
        }
    }
    return null
}

/**
 * Look for an `AGENT_NOTIFY_SUMMARY {...json...}` footer as the **last
 * non-empty line** of an agent's plain-text message.
 *
 * End-anchor: trailing blank lines are fine, but prose on a later
 * non-empty line is non-compliant and returns null. Mid-body quotes of
 * the token are ignored for the same reason. An optional prose prefix on
 * the last line itself is tolerated when the line still ends with a
 * well-formed `AGENT_NOTIFY_SUMMARY {…}` payload.
 *
 * Returns the parsed object on success, `null` on any deviation. The
 * shape is intentionally loose - we only trust `summary`, `action`, and
 * `status` for notification rendering, but the full object is forwarded
 * onto the meta-event bus when Phase 2 lands.
 */
export function extractNotifySummary(text: unknown): NotifySummary | null {
    if (typeof text !== 'string' || text.length === 0) return null

    const lines = text.split('\n')
    let lastIdx = lines.length - 1
    while (lastIdx >= 0 && lines[lastIdx].trim() === '') lastIdx -= 1
    if (lastIdx < 0) return null

    const jsonPart = matchNotifySummaryLine(lines[lastIdx].trim())
    if (jsonPart === null) return null

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

export type { RoleWrappedRecord }
