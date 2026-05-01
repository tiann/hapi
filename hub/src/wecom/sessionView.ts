import type { Session } from '../sync/syncEngine'
import type { TaskNotification } from '../notifications/notificationTypes'
import { isFailureStatus } from '../notifications/notificationTypes'
import { getAgentName, getSessionName } from '../notifications/sessionInfo'
import { ACTION_APPROVE, ACTION_DENY, createCallbackData } from './renderer'
import type { TemplateCard } from './types'

const MAX_ARGS_LEN = 200

function sessionUrl(publicUrl: string, sessionId: string): string {
    try {
        return new URL(`/sessions/${sessionId}`, publicUrl).toString()
    } catch {
        const normalized = publicUrl.replace(/\/+$/, '')
        return `${normalized}/sessions/${sessionId}`
    }
}

export { sessionUrl }

function truncate(value: string, max: number): string {
    if (value.length <= max) return value
    return value.slice(0, max - 3) + '...'
}

function formatArgs(tool: string, args: unknown): string {
    if (!args || typeof args !== 'object') return ''
    const obj = args as Record<string, unknown>
    switch (tool) {
        case 'Bash':
            return typeof obj.command === 'string' ? `Command: ${truncate(obj.command, MAX_ARGS_LEN)}` : ''
        case 'Edit':
        case 'Write':
        case 'Read': {
            const file = obj.file_path ?? obj.path
            return typeof file === 'string' ? `File: ${truncate(file, MAX_ARGS_LEN)}` : ''
        }
        default:
            try {
                return `Args: ${truncate(JSON.stringify(args), MAX_ARGS_LEN)}`
            } catch {
                return ''
            }
    }
}

export function buildPermissionCard(session: Session, publicUrl: string): TemplateCard | null {
    const requests = session.agentState?.requests
    if (!requests) return null
    const requestId = Object.keys(requests)[0]
    if (!requestId) return null
    const request = requests[requestId]

    const sidPrefix = session.id.slice(0, 8)
    const reqPrefix = requestId.slice(0, 8)
    const name = getSessionName(session)
    const argsLine = formatArgs(request.tool, request.arguments)

    const card: TemplateCard = {
        card_type: 'button_interaction',
        main_title: { title: 'Permission Request', desc: name },
        sub_title_text: argsLine
            ? `Tool: ${request.tool}\n${argsLine}`
            : `Tool: ${request.tool}`,
        button_list: [
            { text: 'Allow', style: 1, key: createCallbackData(ACTION_APPROVE, session.id, reqPrefix) },
            { text: 'Deny', style: 2, key: createCallbackData(ACTION_DENY, session.id, reqPrefix) }
        ],
        card_action: { type: 1, url: sessionUrl(publicUrl, session.id) },
        task_id: `hapi-${sidPrefix}-${reqPrefix}-${Date.now()}`
    }
    return card
}

export function buildReadyCard(session: Session, publicUrl: string): TemplateCard {
    const agent = getAgentName(session)
    const name = getSessionName(session)
    return {
        card_type: 'text_notice',
        main_title: { title: 'Ready for input', desc: `${agent} · ${name}` },
        sub_title_text: `${agent} is waiting for your command`,
        card_action: { type: 1, url: sessionUrl(publicUrl, session.id) }
    }
}

export function buildTaskCard(
    session: Session,
    notification: TaskNotification,
    publicUrl: string
): TemplateCard {
    const agent = getAgentName(session)
    const name = getSessionName(session)
    const failed = isFailureStatus(notification.status)
    return {
        card_type: 'text_notice',
        main_title: {
            title: failed ? 'Task failed' : 'Task completed',
            desc: `${agent} · ${name}`
        },
        sub_title_text: truncate(notification.summary, 300),
        card_action: { type: 1, url: sessionUrl(publicUrl, session.id) }
    }
}

export function buildSessionCompletionCard(session: Session, publicUrl: string): TemplateCard {
    const agent = getAgentName(session)
    const name = getSessionName(session)
    return {
        card_type: 'text_notice',
        main_title: { title: 'Session completed', desc: `${agent} · ${name}` },
        card_action: { type: 1, url: sessionUrl(publicUrl, session.id) }
    }
}

export function buildSystemReplyCard(title: string, url: string, desc?: string): TemplateCard {
    // WeCom rejects template cards without a valid card_action with errcode
    // 42045 ("Template_Card.card_action missing or invalid"), including on
    // update_template_card replies. Always attach one pointing to publicUrl
    // (or a session URL) so the server accepts the update.
    return {
        card_type: 'text_notice',
        main_title: { title, desc },
        card_action: { type: 1, url }
    }
}
