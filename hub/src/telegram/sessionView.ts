/**
 * Session Notification View for Telegram
 *
 * Provides notification formatting for permission requests.
 * All interactive session views are handled by the Telegram Mini App.
 */

import { InlineKeyboard } from 'grammy'
import type { Machine, Session } from '../sync/syncEngine'
import { ACTIONS } from './callbacks'
import { createCallbackData, getSessionName } from './renderer'
import { getAgentName } from '../notifications/sessionInfo'
import { formatToolArgumentsDetailed } from '../notifications/toolArgs'
import { composeInputRequestNotification, getFirstPendingRequest, isInputRequestTool } from '../notifications/inputRequest'
import { hubT, type HubLocale } from '../i18n/hubI18n'

type NotificationContext = {
    hasContext: boolean
    heading: string
    details: string[]
}

/**
 * Format a compact notification when the agent is ready for input.
 */
export function formatReadyNotification(
    session: Session,
    machine?: Machine,
    locale: HubLocale = 'en'
): string {
    const agentName = getAgentName(session)
    const context = buildNotificationContext(session, machine, locale)

    if (!context.hasContext) {
        return hubT(locale, 'telegram.ready.noContext', { agent: agentName })
    }

    return [
        hubT(locale, 'telegram.ready.heading', { heading: context.heading }),
        '',
        hubT(locale, 'telegram.ready.waiting', { agent: agentName }),
        ...context.details
    ].join('\n')
}

/**
 * Format a compact session notification for permission requests
 */
export function formatSessionNotification(
    session: Session,
    machine?: Machine,
    locale: HubLocale = 'en'
): string {
    const pending = getFirstPendingRequest(session)
    const inputNotification = composeInputRequestNotification(session, pending, locale)
    if (inputNotification) {
        return `${inputNotification.title}\n\n${inputNotification.body}`
    }

    const context = buildNotificationContext(session, machine, locale)
    const lines: string[] = context.hasContext
        ? [
            hubT(locale, 'telegram.permission.actionRequired', { heading: context.heading }),
            '',
            hubT(locale, 'telegram.permission.requests', { agent: getAgentName(session) }),
            ...context.details
        ]
        : [
            hubT(locale, 'telegram.permission.title'),
            '',
            hubT(locale, 'telegram.session', { name: getSessionName(session) })
        ]

    const req = pending?.request
    if (req) {
        lines.push(hubT(locale, 'telegram.tool', { tool: req.tool }))
        const args = formatToolArgumentsDetailed(req.tool, req.arguments, { locale })
        if (args) {
            lines.push(args)
        }
    }

    return lines.join('\n')
}

function buildNotificationContext(
    session: Session,
    machine?: Machine,
    locale: HubLocale = 'en'
): NotificationContext {
    const sessionName = getContextSessionName(session)
    const machineName = getMachineName(session, machine)
    const path = formatSessionPath(session)
    const heading = formatHeading(sessionName, machineName, locale)
    const details: string[] = []

    if (sessionName) {
        details.push(hubT(locale, 'telegram.session', { name: sessionName }))
    }
    if (path) {
        details.push(hubT(locale, 'telegram.path', { path }))
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

function formatHeading(
    sessionName: string | null,
    machineName: string | null,
    locale: HubLocale = 'en'
): string {
    if (sessionName && machineName) {
        return hubT(locale, 'telegram.heading.on', { session: sessionName, machine: machineName })
    }
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
export function createNotificationKeyboard(
    session: Session,
    publicUrl: string,
    locale: HubLocale = 'en'
): InlineKeyboard {
    const keyboard = new InlineKeyboard()
    const pending = getFirstPendingRequest(session)
    const canControl = session.active

    if (canControl && pending && !isInputRequestTool(pending.request.tool)) {
        const requestId = pending.requestId
        const reqPrefix = requestId.slice(0, 8)

        keyboard
            .text(hubT(locale, 'telegram.allow'), createCallbackData(ACTIONS.APPROVE, session.id, reqPrefix))
            .text(hubT(locale, 'telegram.deny'), createCallbackData(ACTIONS.DENY, session.id, reqPrefix))
        keyboard.row()

        keyboard.webApp(
            hubT(locale, 'telegram.details'),
            buildMiniAppDeepLink(publicUrl, `session_${session.id}`)
        )
        return keyboard
    }

    keyboard.webApp(
        hubT(locale, 'telegram.openSession'),
        buildMiniAppDeepLink(publicUrl, `session_${session.id}`)
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
