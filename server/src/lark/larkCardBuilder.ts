import type { Session } from '../sync/syncEngine'
import { buildLarkActionUrl } from '../web/routes/larkAction'

export type PermissionCardContext = {
    sessionId: string
    requestId: string
    action: 'approve' | 'deny'
}

export function buildPermissionRequestCard(params: {
    session: Session
    requestId: string
    toolName: string
    toolArgsText: string
    miniAppUrl: string
    actionSecret: string
}): unknown {
    const { session, requestId, toolName, toolArgsText, miniAppUrl } = params
    const sessionName = getSessionName(session)
    const detailsUrl = buildMiniAppDeepLink(miniAppUrl, `session_${session.id}`)

    const ts = Date.now()
    const allowUrl = buildLarkActionUrl({
        baseUrl: miniAppUrl,
        sessionId: session.id,
        requestId,
        action: 'approve',
        ts,
        secret: params.actionSecret
    })
    const denyUrl = buildLarkActionUrl({
        baseUrl: miniAppUrl,
        sessionId: session.id,
        requestId,
        action: 'deny',
        ts,
        secret: params.actionSecret
    })

    const summary = `**Session:** ${escapeMd(sessionName)}\n**Tool:** ${escapeMd(toolName)}`
    const argsBlock = toolArgsText
        ? `\n\n**Args:**\n\`\`\`\n${escapeCodeBlock(toolArgsText)}\n\`\`\``
        : ''

    // Use div+lark_md for better compatibility across card versions.
    const base = {
        config: {
            wide_screen_mode: true
        },
        header: {
            title: {
                tag: 'plain_text',
                content: 'Permission Request'
            },
            template: 'orange'
        },
        elements: [
            {
                tag: 'div',
                text: {
                    tag: 'lark_md',
                    content: `${summary}${argsBlock}`
                }
            },
            {
                tag: 'action',
                actions: [
                    {
                        tag: 'button',
                        text: { tag: 'plain_text', content: 'Allow' },
                        type: 'primary',
                        url: allowUrl
                    },
                    {
                        tag: 'button',
                        text: { tag: 'plain_text', content: 'Deny' },
                        type: 'danger',
                        url: denyUrl
                    },
                    {
                        tag: 'button',
                        text: { tag: 'plain_text', content: 'Details' },
                        type: 'default',
                        url: detailsUrl
                    }
                ]
            }
        ]
    }

    return base
}

export function buildPermissionResultCard(params: {
    sessionName: string
    result: 'approved' | 'denied'
    toolName?: string
}): unknown {
    const { sessionName, result, toolName } = params
    const template = result === 'approved' ? 'green' : 'red'
    const title = result === 'approved' ? 'Permission Approved' : 'Permission Denied'
    const extra = toolName ? `\n**Tool:** ${escapeMd(toolName)}` : ''

    return {
        config: { wide_screen_mode: true },
        header: {
            title: { tag: 'plain_text', content: title },
            template
        },
        elements: [
            {
                tag: 'div',
                text: {
                    tag: 'lark_md',
                    content: `**Session:** ${escapeMd(sessionName)}${extra}`
                }
            }
        ]
    }
}

function getSessionName(session: Session): string {
    if (session.metadata?.name) return session.metadata.name
    const p = session.metadata?.path
    if (p) {
        const parts = p.split('/')
        return parts[parts.length - 1] || p
    }
    return 'Unknown'
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

function escapeMd(s: string): string {
    return s.replace(/([*_`])/g, '\\$1')
}

function escapeCodeBlock(s: string): string {
    // avoid breaking fenced blocks
    return s.replace(/```/g, '\\`\\`\\`')
}
