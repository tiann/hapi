import { unwrapRoleWrappedRecordEnvelope } from '@hapi/protocol/messages'
import { AGENT_MESSAGE_PAYLOAD_TYPE, isObject } from '@hapi/protocol'
import type { DecryptedMessage, Session } from '@/types/api'
import { VOICE_CONFIG } from '../voiceConfig'

interface SessionMetadata {
    summary?: { text?: string }
    path?: string
    machineId?: string
    homeDir?: string
}

interface ContentItem {
    type: string
    text?: string
    name?: string
    input?: unknown
}

type NormalizedRole = 'assistant' | 'user'

function isContentArray(content: unknown): content is ContentItem[] {
    return Array.isArray(content)
}

function normalizeRole(role: string | null | undefined): NormalizedRole | null {
    if (role === 'agent' || role === 'assistant') return 'assistant'
    if (role === 'user') return 'user'
    return null
}

function unwrapRoleWrappedContent(message: DecryptedMessage): { role: NormalizedRole | null; content: unknown } {
    const record = unwrapRoleWrappedRecordEnvelope(message.content)
    if (!record) {
        return { role: null, content: message.content }
    }
    return { role: normalizeRole(record.role), content: record.content }
}

function unwrapOutputContent(content: unknown): { roleOverride: NormalizedRole | null; content: unknown } {
    if (!isObject(content) || content.type !== 'output') {
        return { roleOverride: null, content }
    }

    const data = isObject(content.data) ? content.data : null
    if (!data || typeof data.type !== 'string') {
        return { roleOverride: null, content }
    }

    const message = isObject(data.message) ? data.message : null
    if (!message) {
        return { roleOverride: null, content }
    }

    const messageContent = (message as { content?: unknown }).content
    if (typeof messageContent === 'undefined') {
        return { roleOverride: null, content }
    }

    const roleOverride = data.type === 'assistant'
        ? 'assistant'
        : data.type === 'user'
            ? 'user'
            : null

    return { roleOverride, content: messageContent }
}

function formatPlainText(role: NormalizedRole | null, text: string): string {
    if (role === 'assistant') {
        return `Claude Code: \n<text>${text}</text>`
    }
    return `User sent message: \n<text>${text}</text>`
}

function formatToolCall(name: string, input: unknown): string {
    if (VOICE_CONFIG.LIMITED_TOOL_CALLS) {
        return `Claude Code is using ${name}`
    }
    return `Claude Code is using ${name} with arguments: <arguments>${JSON.stringify(input)}</arguments>`
}

function formatCodexContent(content: Record<string, unknown>): string | null {
    if (content.type !== AGENT_MESSAGE_PAYLOAD_TYPE) {
        return null
    }

    const data = isObject(content.data) ? content.data : null
    if (!data || typeof data.type !== 'string') {
        return null
    }

    if (data.type === 'message' && typeof data.message === 'string') {
        return formatPlainText('assistant', data.message)
    }

    if (data.type === 'tool-call' && !VOICE_CONFIG.DISABLE_TOOL_CALLS) {
        const name = typeof data.name === 'string' ? data.name : 'unknown'
        return formatToolCall(name, data.input)
    }

    return null
}

/**
 * Format a permission request for natural language context
 */
export function formatPermissionRequest(
    sessionId: string,
    requestId: string,
    toolName: string,
    toolArgs: unknown
): string {
    return `Claude Code is requesting permission to use ${toolName} (session ${sessionId}):
<request_id>${requestId}</request_id>
<tool_name>${toolName}</tool_name>
<tool_args>${JSON.stringify(toolArgs)}</tool_args>`
}

/**
 * Format a single message for voice context
 */
export function formatMessage(message: DecryptedMessage): string | null {
    const lines: string[] = []
    const { role, content: wrappedContent } = unwrapRoleWrappedContent(message)
    const { roleOverride, content } = unwrapOutputContent(wrappedContent)
    const normalizedRole = roleOverride ?? role

    if (!isContentArray(content)) {
        if (typeof content === 'string') {
            return formatPlainText(normalizedRole, content)
        }
        if (isObject(content) && content.type === 'text' && typeof content.text === 'string') {
            return formatPlainText(normalizedRole, content.text)
        }
        if (isObject(content)) {
            return formatCodexContent(content)
        }
        return null
    }

    // Determine message type by checking for tool_use (assistant) vs user content
    const hasToolUse = content.some(item => item.type === 'tool_use')
    const isAssistant = normalizedRole === 'assistant'
        ? true
        : normalizedRole === 'user'
            ? false
            : hasToolUse || content.some(item => item.type === 'text' && content.length === 1 === false)

    for (const item of content) {
        if (item.type === 'text' && item.text) {
            lines.push(formatPlainText(isAssistant ? 'assistant' : 'user', item.text))
        } else if (item.type === 'tool_use' && !VOICE_CONFIG.DISABLE_TOOL_CALLS) {
            const name = item.name || 'unknown'
            lines.push(formatToolCall(name, item.input))
        }
    }

    if (lines.length === 0) {
        return null
    }
    return lines.join('\n\n')
}

export function formatNewSingleMessage(sessionId: string, message: DecryptedMessage): string | null {
    const formatted = formatMessage(message)
    if (!formatted) {
        return null
    }
    return 'New message in session: ' + sessionId + '\n\n' + formatted
}

export function formatNewMessages(sessionId: string, messages: DecryptedMessage[]): string | null {
    const formatted = [...messages]
        .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
        .map(formatMessage)
        .filter(Boolean)
    if (formatted.length === 0) {
        return null
    }
    return 'New messages in session: ' + sessionId + '\n\n' + formatted.join('\n\n')
}

export function formatHistory(sessionId: string, messages: DecryptedMessage[]): string {
    const messagesToFormat = VOICE_CONFIG.MAX_HISTORY_MESSAGES > 0
        ? messages.slice(-VOICE_CONFIG.MAX_HISTORY_MESSAGES)
        : messages
    const formatted = messagesToFormat.map(formatMessage).filter(Boolean)
    return 'History of messages in session: ' + sessionId + '\n\n' + formatted.join('\n\n')
}

export function formatSessionFull(session: Session | null, messages: DecryptedMessage[]): string {
    if (!session) {
        return 'Session not available'
    }

    const sessionName = session.metadata?.summary?.text
    const sessionPath = session.metadata?.path
    const lines: string[] = []

    lines.push(`# Session ID: ${session.id}`)
    lines.push(`# Project path: ${sessionPath}`)
    lines.push(`# Session summary:\n${sessionName}`)

    if (session.metadata?.summary?.text) {
        lines.push('## Session Summary')
        lines.push(session.metadata.summary.text)
        lines.push('')
    }

    lines.push('## Our interaction history so far')
    lines.push('')
    lines.push(formatHistory(session.id, messages))

    return lines.join('\n\n')
}

export function formatSessionOffline(sessionId: string, _metadata?: SessionMetadata): string {
    return `Session went offline: ${sessionId}`
}

export function formatSessionOnline(sessionId: string, _metadata?: SessionMetadata): string {
    return `Session came online: ${sessionId}`
}

export function formatSessionFocus(sessionId: string, _metadata?: SessionMetadata): string {
    return `Session became focused: ${sessionId}`
}

export function formatReadyEvent(sessionId: string): string {
    return `Claude Code done working in session: ${sessionId}. The previous message(s) are the summary of the work done. Report this to the human immediately.`
}
