/**
 * Session Notification View for Telegram
 *
 * Provides notification formatting for permission requests.
 * All interactive session views are handled by the Telegram Mini App.
 */

import { InlineKeyboard } from 'grammy'
import type { Machine, Session } from '../sync/syncEngine'
import { ACTIONS } from './callbacks'
import { createCallbackData, truncate, getSessionName } from './renderer'
import { getAgentName } from '../notifications/sessionInfo'

const MAX_TOOL_ARGS_LENGTH = 150

type NotificationContext = {
    hasContext: boolean
    heading: string
    details: string[]
}

/**
 * Format a compact notification when the agent is ready for input.
 */
export function formatReadyNotification(session: Session, machine?: Machine): string {
    const agentName = getAgentName(session)
    const context = buildNotificationContext(session, machine)

    if (!context.hasContext) {
        return `It's ready!\n\n${agentName} is waiting for your command`
    }

    return [
        `Ready: ${context.heading}`,
        '',
        `${agentName} is waiting for your command`,
        ...context.details
    ].join('\n')
}

/**
 * Format a compact session notification for permission requests
 */
export function formatSessionNotification(session: Session, machine?: Machine): string {
    const context = buildNotificationContext(session, machine)
    const lines: string[] = context.hasContext
        ? [
            `Action required: ${context.heading}`,
            '',
            `${getAgentName(session)} requests permission`,
            ...context.details
        ]
        : ['Permission Request', '', `Session: ${getSessionName(session)}`]

    const requests = session.agentState?.requests
    if (requests) {
        const reqId = Object.keys(requests)[0]
        const req = requests[reqId]
        if (req) {
            lines.push(`Tool: ${req.tool}`)
            const args = formatToolArgumentsDetailed(req.tool, req.arguments)
            if (args) {
                lines.push(args)
            }
        }
    }

    return lines.join('\n')
}

function buildNotificationContext(session: Session, machine?: Machine): NotificationContext {
    const sessionName = getContextSessionName(session)
    const machineName = getMachineName(session, machine)
    const path = formatSessionPath(session)
    const heading = formatHeading(sessionName, machineName)
    const details: string[] = []

    if (sessionName) {
        details.push(`Session: ${sessionName}`)
    }
    if (path) {
        details.push(`Path: ${path}`)
    }

    return {
        hasContext: Boolean(heading || details.length > 0),
        heading: heading || getSessionName(session),
        details
    }
}

function getContextSessionName(session: Session): string | null {
    if (session.metadata?.name) return session.metadata.name
    if (session.metadata?.summary?.text) return session.metadata.summary.text
    if (session.metadata?.path) return getSessionName(session)
    return null
}

function getMachineName(session: Session, machine?: Machine): string | null {
    const name = machine?.metadata?.displayName
        ?? machine?.metadata?.host
        ?? session.metadata?.host
        ?? null
    const trimmed = name?.trim()
    return trimmed ? trimmed : null
}

function formatHeading(sessionName: string | null, machineName: string | null): string {
    if (sessionName && machineName) return `${sessionName} on ${machineName}`
    if (sessionName) return sessionName
    if (machineName) return machineName
    return ''
}

function formatSessionPath(session: Session): string | null {
    const path = session.metadata?.path?.trim()
    if (!path) return null

    const homeDir = session.metadata?.homeDir?.trim()
    if (!homeDir) return path
    if (path === homeDir) return '~'
    if (path.startsWith(`${homeDir}/`)) {
        return `~/${path.slice(homeDir.length + 1)}`
    }
    return path
}

/**
 * Create notification keyboard for quick actions
 */
export function createNotificationKeyboard(session: Session, publicUrl: string): InlineKeyboard {
    const keyboard = new InlineKeyboard()
    const requests = session.agentState?.requests ?? null
    const hasRequests = Boolean(requests && Object.keys(requests).length > 0)
    const canControl = session.active

    if (canControl && hasRequests) {
        const requestId = Object.keys(requests!)[0]
        const reqPrefix = requestId.slice(0, 8)

        keyboard
            .text('Allow', createCallbackData(ACTIONS.APPROVE, session.id, reqPrefix))
            .text('Deny', createCallbackData(ACTIONS.DENY, session.id, reqPrefix))
        keyboard.row()

        keyboard.webApp(
            'Details',
            buildMiniAppDeepLink(publicUrl, `session_${session.id}`)
        )
        return keyboard
    }

    keyboard.webApp(
        'Open Session',
        buildMiniAppDeepLink(publicUrl, `session_${session.id}`)
    )
    return keyboard
}

/**
 * Format detailed tool arguments for notification display
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

            case 'Agent':
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
