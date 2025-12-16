/**
 * Message Renderer for Telegram
 *
 * Formats session data, messages, and other content for Telegram display.
 * Handles truncation to respect Telegram's message limits.
 */

import type { Session, Machine, DecryptedMessage } from '../sync/syncEngine'

// Telegram limits
const MAX_MESSAGE_LENGTH = 4096
const MAX_CALLBACK_DATA = 64

/**
 * Truncate text to fit within a limit
 */
export function truncate(text: string, maxLen: number = MAX_MESSAGE_LENGTH - 100): string {
    if (text.length <= maxLen) return text
    return text.slice(0, maxLen - 3) + '...'
}

/**
 * Escape special characters for Telegram MarkdownV2
 */
export function escapeMarkdown(text: string): string {
    return text.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&')
}

/**
 * Get status emoji for a session
 */
export function getSessionStatusEmoji(session: Session): string {
    const hasRequests = session.agentState?.requests && Object.keys(session.agentState.requests).length > 0

    if (hasRequests) return '🔔' // Permission needed
    if (session.thinking) return '💭' // Thinking
    if (session.active) return '🟢' // Active
    return '⚪' // Inactive
}

/**
 * Get status text for a session
 */
export function getSessionStatusText(session: Session): string {
    const hasRequests = session.agentState?.requests && Object.keys(session.agentState.requests).length > 0

    if (hasRequests) return 'Permission needed'
    if (session.thinking) return 'Thinking'
    if (session.active) return 'Active'
    return 'Inactive'
}

/**
 * Get session name (project name or directory name)
 */
export function getSessionName(session: Session): string {
    if (session.metadata?.name) return session.metadata.name
    if (session.metadata?.path) {
        const parts = session.metadata.path.split('/')
        return parts[parts.length - 1] || session.metadata.path
    }
    return 'Unknown'
}

/**
 * Format session list for display
 */
export function formatSessionList(sessions: Session[]): string {
    if (sessions.length === 0) {
        return 'No active sessions.\n\nUse /app to open the Mini App and create a new session.'
    }

    let message = `Active Sessions (${sessions.length}):\n\n`

    // Sort sessions: permission needed first, then by activity
    const sorted = [...sessions].sort((a, b) => {
        const aHasReq = a.agentState?.requests && Object.keys(a.agentState.requests).length > 0
        const bHasReq = b.agentState?.requests && Object.keys(b.agentState.requests).length > 0

        if (aHasReq && !bHasReq) return -1
        if (!aHasReq && bHasReq) return 1
        if (a.thinking && !b.thinking) return -1
        if (!a.thinking && b.thinking) return 1
        if (a.active && !b.active) return -1
        if (!a.active && b.active) return 1
        return b.activeAt - a.activeAt
    })

    // Show up to 10 sessions
    const display = sorted.slice(0, 10)

    for (let i = 0; i < display.length; i++) {
        const session = display[i]
        const num = i + 1
        const emoji = getSessionStatusEmoji(session)
        const name = getSessionName(session)
        const status = getSessionStatusText(session)
        const path = session.metadata?.path || ''

        message += `${num}. ${emoji} ${name}\n`
        if (path) {
            message += `   ${truncate(path, 50)}\n`
        }
        message += `   ${status}\n\n`
    }

    if (sessions.length > 10) {
        message += `... and ${sessions.length - 10} more sessions`
    }

    return truncate(message)
}

/**
 * Format session detail for display
 */
export function formatSessionDetail(session: Session, messages: DecryptedMessage[] = []): string {
    const name = getSessionName(session)
    const status = getSessionStatusText(session)
    const statusEmoji = getSessionStatusEmoji(session)
    const path = session.metadata?.path || 'Unknown'
    const host = session.metadata?.host || 'Unknown'
    const mode = session.permissionMode || 'default'

    let message = `${statusEmoji} ${name}\n\n`
    message += `Path: ${path}\n`
    message += `Host: ${host}\n`
    message += `Status: ${status}\n`
    message += `Mode: ${mode}\n`

    // Check for permission requests
    const requests = session.agentState?.requests
    if (requests && Object.keys(requests).length > 0) {
        message += '\n--- Permission Request ---\n'
        for (const [reqId, req] of Object.entries(requests)) {
            message += `Tool: ${req.tool}\n`
            if (req.arguments) {
                const args = formatToolArguments(req.tool, req.arguments)
                if (args) {
                    message += `${args}\n`
                }
            }
        }
    }

    // Show recent messages if available
    if (messages.length > 0) {
        message += '\n--- Recent Messages ---\n'
        const recent = messages.slice(-5) // Last 5 messages

        for (const msg of recent) {
            const formatted = formatMessage(msg)
            if (formatted) {
                message += formatted + '\n'
            }
        }
    }

    // Add summary if available
    if (session.metadata?.summary?.text) {
        message += '\n--- Summary ---\n'
        message += truncate(session.metadata.summary.text, 500) + '\n'
    }

    return truncate(message)
}

/**
 * Format tool arguments for display
 */
function formatToolArguments(tool: string, args: any): string {
    try {
        switch (tool) {
            case 'Edit':
            case 'Write':
            case 'Read':
                return `File: ${args.file_path || args.path || 'unknown'}`
            case 'Bash':
                const cmd = args.command || ''
                return `Command: ${truncate(cmd, 100)}`
            case 'Task':
                return `Task: ${truncate(args.prompt || args.description || '', 100)}`
            case 'Grep':
            case 'Glob':
                return `Pattern: ${args.pattern || ''}`
            default:
                return ''
        }
    } catch {
        return ''
    }
}

/**
 * Format a single message for display
 */
function formatMessage(msg: DecryptedMessage): string {
    try {
        const content = msg.content
        if (!content || typeof content !== 'object') return ''

        const contentObj = content as Record<string, unknown>

        const role = typeof contentObj.role === 'string' ? contentObj.role : 'unknown'
        const roleEmoji = role === 'user' ? '👤' : role === 'assistant' ? '🤖' : '🔧'

        const inner = contentObj.content

        // Handle different content types
        if (inner && typeof inner === 'object') {
            const innerObj = inner as Record<string, unknown>
            if (innerObj.type === 'text') {
                const text = typeof innerObj.text === 'string' ? innerObj.text : ''
                return `${roleEmoji} ${truncate(text, 200)}`
            }

            if (innerObj.type === 'tool_use') {
                const toolName = typeof innerObj.name === 'string' ? innerObj.name : 'unknown'
                return `🔧 ${toolName}`
            }

            if (innerObj.type === 'tool_result') {
                return `✓ Tool completed`
            }
        }

        if (inner && typeof inner === 'object') {
            return ''
        }

        if (typeof inner === 'string') {
            return `${roleEmoji} ${truncate(inner, 200)}`
        }

        // Backward-compat fallback for older content shapes
        if (typeof (contentObj as { content?: unknown }).content === 'string') {
            const text = (contentObj as { content: string }).content
            return `${roleEmoji} ${truncate(text, 200)}`
        }

        return ''
    } catch {
        return ''
    }
}

/**
 * Format machine list for display
 */
export function formatMachineList(machines: Machine[]): string {
    if (machines.length === 0) {
        return 'No machines online.\n\nMake sure you have the Happy daemon running on your machines.'
    }

    let message = `Online Machines (${machines.length}):\n\n`

    for (let i = 0; i < machines.length; i++) {
        const machine = machines[i]
        const num = i + 1
        const name = machine.metadata?.displayName || machine.metadata?.host || 'Unknown'
        const platform = machine.metadata?.platform || ''
        const version = machine.metadata?.happyCliVersion || ''

        message += `${num}. 🟢 ${name}\n`
        if (platform) {
            message += `   Platform: ${platform}\n`
        }
        if (version) {
            message += `   Version: ${version}\n`
        }
        message += '\n'
    }

    return truncate(message)
}

/**
 * Create callback data with size limit
 * Format: action:sessionIdPrefix:extraData
 */
export function createCallbackData(action: string, sessionId: string, extra?: string): string {
    // Use 8-char prefix for session ID to save space
    const sessionPrefix = sessionId.slice(0, 8)
    let data = `${action}:${sessionPrefix}`

    if (extra) {
        // Ensure we don't exceed 64 bytes
        const remaining = MAX_CALLBACK_DATA - data.length - 1
        if (remaining > 0) {
            data += `:${extra.slice(0, remaining)}`
        }
    }

    return data.slice(0, MAX_CALLBACK_DATA)
}

/**
 * Parse callback data
 */
export function parseCallbackData(data: string): { action: string; sessionPrefix: string; extra?: string } {
    const parts = data.split(':')
    return {
        action: parts[0] || '',
        sessionPrefix: parts[1] || '',
        extra: parts[2]
    }
}

/**
 * Find session by ID prefix
 */
export function findSessionByPrefix(sessions: Session[], prefix: string): Session | undefined {
    return sessions.find(s => s.id.startsWith(prefix))
}

/**
 * Find machine by ID prefix
 */
export function findMachineByPrefix(machines: Machine[], prefix: string): Machine | undefined {
    return machines.find(m => m.id.startsWith(prefix))
}
