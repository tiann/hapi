/**
 * Session Detail View for Telegram
 *
 * Provides detailed session information display including:
 * - Session metadata (path, host, status, mode)
 * - Recent messages with proper formatting
 * - Permission request details
 * - Session summary
 */

import { InlineKeyboard } from 'grammy'
import type { Session, DecryptedMessage, SyncEngine } from '../sync/syncEngine'
import { configuration } from '../configuration'
import { ACTIONS } from './callbacks'
import { createCallbackData, truncate, getSessionStatusEmoji, getSessionStatusText, getSessionName } from './renderer'

// Maximum message display
const MAX_MESSAGES_DISPLAY = 8
const MAX_MESSAGE_LENGTH = 300
const MAX_TOOL_ARGS_LENGTH = 150

/**
 * Format session detail view with full information
 */
export function formatSessionDetailView(
    session: Session,
    messages: DecryptedMessage[] = []
): string {
    const lines: string[] = []

    // Header
    const name = getSessionName(session)
    const emoji = getSessionStatusEmoji(session)
    lines.push(`${emoji} ${name}`)
    lines.push('')

    // Metadata
    if (session.metadata?.path) {
        lines.push(`Path: ${session.metadata.path}`)
    }
    if (session.metadata?.host) {
        lines.push(`Host: ${session.metadata.host}`)
    }

    // Status line
    const status = getSessionStatusText(session)
    const mode = formatPermissionMode(session.permissionMode)
    const model = formatModelMode(session.modelMode)
    lines.push(`Status: ${status} | Mode: ${mode}${model ? ` | ${model}` : ''}`)
    lines.push('')

    // Permission requests
    const requests = session.agentState?.requests
    if (requests && Object.keys(requests).length > 0) {
        lines.push('--- Permission Request ---')
        for (const [reqId, req] of Object.entries(requests)) {
            lines.push(`Tool: ${req.tool}`)
            const argsDisplay = formatToolArgumentsDetailed(req.tool, req.arguments)
            if (argsDisplay) {
                lines.push(argsDisplay)
            }
        }
        lines.push('')
    }

    // Recent messages
    if (messages.length > 0) {
        lines.push('--- Recent Messages ---')
        const recentMessages = messages.slice(-MAX_MESSAGES_DISPLAY)

        for (const msg of recentMessages) {
            const formatted = formatMessageDetailed(msg)
            if (formatted) {
                lines.push(formatted)
            }
        }
        lines.push('')
    }

    // Summary
    if (session.metadata?.summary?.text) {
        lines.push('--- Summary ---')
        const summaryText = truncate(session.metadata.summary.text, 500)
        lines.push(summaryText)
        lines.push('')
    }

    // Activity info
    if (session.activeAt) {
        const lastActive = formatTimeAgo(session.activeAt)
        lines.push(`Last active: ${lastActive}`)
    }

    return truncate(lines.join('\n'), 4000)
}

/**
 * Create session detail keyboard with contextual actions
 */
export function createSessionDetailKeyboard(session: Session): InlineKeyboard {
    const keyboard = new InlineKeyboard()
    const hasRequests = session.agentState?.requests && Object.keys(session.agentState.requests).length > 0
    const canControl = session.active

    // Permission buttons if there are pending requests
    if (canControl && hasRequests) {
        const requestId = Object.keys(session.agentState!.requests!)[0]
        const reqPrefix = requestId.slice(0, 8)

        keyboard
            .text('✅ Allow', createCallbackData(ACTIONS.APPROVE, session.id, reqPrefix))
            .text('✅✅ Edits', createCallbackData(ACTIONS.APPROVE_EDITS, session.id, reqPrefix))
            .text('❌ Deny', createCallbackData(ACTIONS.DENY, session.id, reqPrefix))
        keyboard.row()

        // Add bypass option
        keyboard.text('⚡ Bypass All', createCallbackData(ACTIONS.APPROVE_BYPASS, session.id, reqPrefix))
        keyboard.row()
    }

    // Control buttons
    keyboard.text('🔄 Refresh', createCallbackData(ACTIONS.REFRESH_SESSION, session.id))
    if (canControl) {
        keyboard.text('⏹ Abort', createCallbackData(ACTIONS.ABORT, session.id))
    }
    keyboard.row()

    // Settings and navigation
    keyboard
        .text('⚙️ Settings', createCallbackData(ACTIONS.SETTINGS, session.id))
        .text('← Back', createCallbackData(ACTIONS.BACK_TO_LIST, 'back'))

    return keyboard
}

/**
 * Format detailed tool arguments
 */
function formatToolArgumentsDetailed(tool: string, args: any): string {
    if (!args) return ''

    try {
        switch (tool) {
            case 'Edit': {
                const file = args.file_path || args.path || 'unknown'
                const oldStr = args.old_string ? truncate(args.old_string, 50) : ''
                const newStr = args.new_string ? truncate(args.new_string, 50) : ''
                let result = `File: ${truncate(file, MAX_TOOL_ARGS_LENGTH)}`
                if (oldStr) result += `\nOld: "${oldStr}"`
                if (newStr) result += `\nNew: "${newStr}"`
                return result
            }

            case 'Write': {
                const file = args.file_path || args.path || 'unknown'
                const content = args.content ? `${args.content.length} chars` : ''
                return `File: ${truncate(file, MAX_TOOL_ARGS_LENGTH)}${content ? ` (${content})` : ''}`
            }

            case 'Read': {
                const file = args.file_path || args.path || 'unknown'
                return `File: ${truncate(file, MAX_TOOL_ARGS_LENGTH)}`
            }

            case 'Bash': {
                const cmd = args.command || ''
                return `Command: ${truncate(cmd, MAX_TOOL_ARGS_LENGTH)}`
            }

            case 'Task': {
                const desc = args.description || args.prompt || ''
                return `Task: ${truncate(desc, MAX_TOOL_ARGS_LENGTH)}`
            }

            case 'Grep':
            case 'Glob': {
                const pattern = args.pattern || ''
                const path = args.path || ''
                let result = `Pattern: ${pattern}`
                if (path) result += `\nPath: ${truncate(path, 80)}`
                return result
            }

            case 'WebFetch': {
                const url = args.url || ''
                return `URL: ${truncate(url, MAX_TOOL_ARGS_LENGTH)}`
            }

            case 'TodoWrite': {
                const count = args.todos?.length || 0
                return `Updating ${count} todo items`
            }

            default: {
                // Generic args display for unknown tools
                const argStr = JSON.stringify(args)
                if (argStr.length > 10) {
                    return `Args: ${truncate(argStr, MAX_TOOL_ARGS_LENGTH)}`
                }
                return ''
            }
        }
    } catch {
        return ''
    }
}

/**
 * Format a message with more detail
 */
function formatMessageDetailed(msg: DecryptedMessage): string {
    if (!msg.content || typeof msg.content !== 'object') return ''

    try {
        const contentObj = msg.content as Record<string, unknown>
        const role = typeof contentObj.role === 'string' ? contentObj.role : 'unknown'
        const roleEmoji = role === 'user' ? '👤' : role === 'assistant' ? '🤖' : '🔧'

        const inner = contentObj.content

        if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
            const innerObj = inner as Record<string, unknown>

            if (innerObj.type === 'text') {
                const text = typeof innerObj.text === 'string' ? innerObj.text : ''
                return `${roleEmoji} ${truncate(text, MAX_MESSAGE_LENGTH)}`
            }

            if (innerObj.type === 'tool_use') {
                const toolName = typeof innerObj.name === 'string' ? innerObj.name : 'unknown'
                let display = `🔧 ${toolName}`

                const input = innerObj.input
                if (input && typeof input === 'object') {
                    const inputObj = input as Record<string, unknown>
                    if (typeof inputObj.file_path === 'string') {
                        const fileName = inputObj.file_path.split('/').pop()
                        display += `: ${fileName}`
                    } else if (typeof inputObj.command === 'string') {
                        display += `: ${truncate(inputObj.command, 50)}`
                    } else if (typeof inputObj.pattern === 'string') {
                        display += `: ${inputObj.pattern}`
                    }
                }

                return display
            }

            if (innerObj.type === 'tool_result') {
                const isError = Boolean(innerObj.is_error)
                return isError ? '❌ Tool failed' : '✓ Tool completed'
            }
        }

        if (Array.isArray(inner)) {
            const first = inner[0]
            if (first && typeof first === 'object') {
                const firstObj = first as Record<string, unknown>
                if (firstObj.type === 'text') {
                    const text = typeof firstObj.text === 'string' ? firstObj.text : ''
                    return `${roleEmoji} ${truncate(text, MAX_MESSAGE_LENGTH)}`
                }
                if (firstObj.type === 'tool_use') {
                    const name = typeof firstObj.name === 'string' ? firstObj.name : 'Tool'
                    return `🔧 ${name}`
                }
            }
        }

        if (typeof inner === 'string') {
            return `${roleEmoji} ${truncate(inner, MAX_MESSAGE_LENGTH)}`
        }

        return ''
    } catch {
        return ''
    }
}

/**
 * Format permission mode for display
 */
function formatPermissionMode(mode?: string | null): string {
    switch (mode) {
        case 'acceptEdits':
            return 'Accept Edits'
        case 'bypassPermissions':
            return 'Bypass'
        case 'plan':
            return 'Plan'
        default:
            return 'Default'
    }
}

/**
 * Format model mode for display
 */
function formatModelMode(mode?: string | null): string {
    switch (mode) {
        case 'sonnet':
            return 'Sonnet'
        case 'opus':
            return 'Opus'
        default:
            return ''
    }
}

/**
 * Format timestamp as time ago
 */
function formatTimeAgo(timestamp: number): string {
    const now = Date.now()
    const diff = now - timestamp

    const seconds = Math.floor(diff / 1000)
    const minutes = Math.floor(seconds / 60)
    const hours = Math.floor(minutes / 60)
    const days = Math.floor(hours / 24)

    if (days > 0) return `${days}d ago`
    if (hours > 0) return `${hours}h ago`
    if (minutes > 0) return `${minutes}m ago`
    if (seconds > 10) return `${seconds}s ago`
    return 'just now'
}

/**
 * Create a compact session card for notifications
 */
export function formatSessionNotification(
    session: Session,
    eventType: 'permission' | 'message' | 'status'
): string {
    const name = getSessionName(session)
    const emoji = getSessionStatusEmoji(session)

    let title = ''
    let details = ''

    switch (eventType) {
        case 'permission': {
            title = 'Permission Request'
            const requests = session.agentState?.requests
            if (requests) {
                const reqId = Object.keys(requests)[0]
                const req = requests[reqId]
                if (req) {
                    details = `Tool: ${req.tool}`
                    const args = formatToolArgumentsDetailed(req.tool, req.arguments)
                    if (args) {
                        details += `\n${args}`
                    }
                }
            }
            break
        }

        case 'message':
            title = '💬 New Message'
            break

        case 'status':
            title = `${emoji} Status Update`
            details = getSessionStatusText(session)
            break
    }

    return `${title}\n\nSession: ${name}\n${details}`.trim()
}

/**
 * Create notification keyboard for quick actions
 */
export function createNotificationKeyboard(session: Session): InlineKeyboard {
    const keyboard = new InlineKeyboard()
    const requests = session.agentState?.requests ?? null
    const hasRequests = Boolean(requests && Object.keys(requests).length > 0)
    const canControl = session.active

    if (canControl && hasRequests) {
        const requestId = Object.keys(requests!)[0]
        const reqPrefix = requestId.slice(0, 8)

        keyboard
            .text('✅ Allow', createCallbackData(ACTIONS.APPROVE, session.id, reqPrefix))
            .text('❌ Deny', createCallbackData(ACTIONS.DENY, session.id, reqPrefix))
        keyboard.row()

        keyboard.webApp(
            'Details',
            buildMiniAppDeepLink(configuration.miniAppUrl, `session_${session.id}`)
        )
        return keyboard
    }

    keyboard.webApp(
        'Open Session',
        buildMiniAppDeepLink(configuration.miniAppUrl, `session_${session.id}`)
    )
    return keyboard
}

function buildMiniAppDeepLink(baseUrl: string, startParam: string): string {
    try {
        const url = new URL(baseUrl)
        url.searchParams.set('startapp', startParam)
        return url.toString()
    } catch {
        const separator = baseUrl.includes('?') ? '&' : '?'
        return `${baseUrl}${separator}startapp=${encodeURIComponent(startParam)}`
    }
}

/**
 * Format settings view for a session
 */
export function formatSettingsView(session: Session): string {
    const name = getSessionName(session)
    const currentMode = formatPermissionMode(session.permissionMode)
    const currentModel = session.modelMode || 'default'

    const lines = [
        `⚙️ Settings: ${name}`,
        '',
        `Permission Mode: ${currentMode}`,
        `Model: ${currentModel === 'default' ? 'Default' : currentModel === 'sonnet' ? 'Sonnet' : 'Opus'}`,
        '',
        'Select options below to change settings.'
    ]

    return lines.join('\n')
}

/**
 * Create settings keyboard
 */
export function createSettingsKeyboard(session: Session): InlineKeyboard {
    const keyboard = new InlineKeyboard()
    if (!session.active) {
        keyboard.text('← Back to Session', createCallbackData(ACTIONS.BACK_TO_SESSION, session.id))
        return keyboard
    }

    const currentMode = session.permissionMode || 'default'
    const currentModel = session.modelMode || 'default'

    // Permission mode row 1
    keyboard.text(
        currentMode === 'default' ? '✓ Default' : 'Default',
        createCallbackData(ACTIONS.SET_MODE_DEFAULT, session.id)
    )
    keyboard.text(
        currentMode === 'acceptEdits' ? '✓ Accept Edits' : 'Accept Edits',
        createCallbackData(ACTIONS.SET_MODE_EDITS, session.id)
    )
    keyboard.row()

    // Permission mode row 2
    keyboard.text(
        currentMode === 'bypassPermissions' ? '✓ Bypass' : 'Bypass',
        createCallbackData(ACTIONS.SET_MODE_BYPASS, session.id)
    )
    keyboard.text(
        currentMode === 'plan' ? '✓ Plan' : 'Plan',
        createCallbackData(ACTIONS.SET_MODE_PLAN, session.id)
    )
    keyboard.row()

    // Model row
    keyboard.text(
        currentModel === 'sonnet' ? '✓ Sonnet' : 'Sonnet',
        createCallbackData(ACTIONS.SET_MODEL_SONNET, session.id)
    )
    keyboard.text(
        currentModel === 'opus' ? '✓ Opus' : 'Opus',
        createCallbackData(ACTIONS.SET_MODEL_OPUS, session.id)
    )
    keyboard.row()

    // Actions
    keyboard.text('⏹ Abort Session', createCallbackData(ACTIONS.ABORT, session.id))
    keyboard.row()

    // Back button
    keyboard.text('← Back to Session', createCallbackData(ACTIONS.BACK_TO_SESSION, session.id))

    return keyboard
}
