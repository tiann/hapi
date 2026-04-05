/**
 * Feishu Card Message Builder
 *
 * Provides helper functions to build interactive card messages for Feishu.
 *
 * @see https://open.feishu.cn/document/server-side/card-kit/interactive-card
 */

import type { Session } from '../sync/syncEngine'
import { getAgentName, getSessionName } from '../notifications/sessionInfo'

/**
 * Build a permission request card
 */
export function buildPermissionCard(session: Session, publicUrl: string): unknown {
    const sessionName = getSessionName(session)
    const agentName = getAgentName(session)

    const requests = session.agentState?.requests
    let toolInfo = 'No pending requests'
    let hasRequests = false

    if (requests) {
        const requestIds = Object.keys(requests)
        if (requestIds.length > 0) {
            hasRequests = true
            const req = requests[requestIds[0]]
            if (req) {
                toolInfo = formatToolInfo(req.tool, req.arguments)
            }
        }
    }

    const card: Record<string, unknown> = {
        config: {
            wide_screen_mode: true,
            enable_forward: true,
        },
        header: {
            title: {
                tag: 'plain_text',
                content: `🔔 Permission Request - ${agentName}`,
            },
            subtitle: {
                tag: 'plain_text',
                content: `Session: ${sessionName}`,
            },
        },
        elements: [
            {
                tag: 'div',
                text: {
                    tag: 'lark_md',
                    content: toolInfo,
                },
            },
        ],
    }

    if (hasRequests) {
        const requestId = Object.keys(requests!)[0]

        // @ts-expect-error elements exists
        card.elements.push({
            tag: 'action',
            actions: [
                {
                    tag: 'button',
                    text: {
                        tag: 'plain_text',
                        content: '✅ Allow',
                    },
                    type: 'primary',
                    value: {
                        action: 'approve',
                        sessionId: session.id,
                        requestId: requestId,
                    },
                },
                {
                    tag: 'button',
                    text: {
                        tag: 'plain_text',
                        content: '❌ Deny',
                    },
                    type: 'danger',
                    value: {
                        action: 'deny',
                        sessionId: session.id,
                        requestId: requestId,
                    },
                },
            ],
        })
    }

    // @ts-expect-error elements exists
    card.elements.push({
        tag: 'hr',
    }, {
        tag: 'note',
        elements: [
            {
                tag: 'plain_text',
                content: `Session ID: ${session.id.slice(0, 8)}...`,
            },
        ],
    })

    return card
}

/**
 * Build a "ready" notification card
 */
export function buildReadyCard(session: Session, publicUrl: string): unknown {
    const sessionName = getSessionName(session)
    const agentName = getAgentName(session)

    return {
        config: {
            wide_screen_mode: true,
        },
        header: {
            title: {
                tag: 'plain_text',
                content: `✅ ${agentName} is Ready`,
            },
            subtitle: {
                tag: 'plain_text',
                content: `Session: ${sessionName}`,
            },
        },
        elements: [
            {
                tag: 'div',
                text: {
                    tag: 'lark_md',
                    content: `The agent is waiting for your next command.`,
                },
            },
            {
                tag: 'action',
                actions: [
                    {
                        tag: 'button',
                        text: {
                            tag: 'plain_text',
                            content: 'Send Message',
                        },
                        type: 'primary',
                        value: {
                            action: 'send_message',
                            sessionId: session.id,
                        },
                    },
                    {
                        tag: 'button',
                        text: {
                            tag: 'plain_text',
                            content: 'View Sessions',
                        },
                        type: 'default',
                        value: {
                            action: 'list_sessions',
                        },
                    },
                ],
            },
            {
                tag: 'hr',
            },
            {
                tag: 'note',
                elements: [
                    {
                        tag: 'plain_text',
                        content: `Session ID: ${session.id.slice(0, 8)}...`,
                    },
                ],
            },
        ],
    }
}

/**
 * Build a session list card
 */
export function buildSessionListCard(sessions: Session[]): unknown {
    const elements: unknown[] = []

    if (sessions.length === 0) {
        elements.push({
            tag: 'div',
            text: {
                tag: 'lark_md',
                content: 'No active sessions.',
            },
        })
    } else {
        for (const session of sessions) {
            const sessionName = getSessionName(session)
            const agentName = getAgentName(session)
            const status = session.active ? '🟢 Active' : '🔴 Inactive'

            elements.push({
                tag: 'div',
                fields: [
                    {
                        is_short: true,
                        text: {
                            tag: 'lark_md',
                            content: `**${sessionName}**\n${agentName}`,
                        },
                    },
                    {
                        is_short: true,
                        text: {
                            tag: 'lark_md',
                            content: `${status}\n${session.id.slice(0, 8)}...`,
                        },
                    },
                ],
            }, {
                tag: 'action',
                actions: [
                    {
                        tag: 'button',
                        text: {
                            tag: 'plain_text',
                            content: 'Send Message',
                        },
                        type: 'primary',
                        value: {
                            action: 'send_message',
                            sessionId: session.id,
                        },
                    },
                ],
            }, {
                tag: 'hr',
            })
        }
    }

    return {
        config: {
            wide_screen_mode: true,
        },
        header: {
            title: {
                tag: 'plain_text',
                content: '📋 Active Sessions',
            },
        },
        elements,
    }
}

/**
 * Build a help card
 */
export function buildHelpCard(): unknown {
    return {
        config: {
            wide_screen_mode: true,
        },
        header: {
            title: {
                tag: 'plain_text',
                content: '❓ HAPI Bot Help',
            },
        },
        elements: [
            {
                tag: 'div',
                text: {
                    tag: 'lark_md',
                    content: `**Available Commands:**`,
                },
            },
            {
                tag: 'div',
                text: {
                    tag: 'lark_md',
                    content: `
• **/bind <token>** - Bind your Feishu account to a namespace
• **/sessions** - List all active sessions
• **/send <session_id> <message>** - Send a message to an agent
• **/help** - Show this help message
• **Direct message** - Send to the active session (if bound)
                    `.trim(),
                },
            },
            {
                tag: 'hr',
            },
            {
                tag: 'note',
                elements: [
                    {
                        tag: 'plain_text',
                        content: 'Use the buttons below or type commands directly.',
                    },
                ],
            },
            {
                tag: 'action',
                actions: [
                    {
                        tag: 'button',
                        text: {
                            tag: 'plain_text',
                            content: '📋 List Sessions',
                        },
                        type: 'primary',
                        value: {
                            action: 'list_sessions',
                        },
                    },
                ],
            },
        ],
    }
}

/**
 * Build a success/error response card
 */
export function buildResponseCard(message: string, isError = false): unknown {
    return {
        config: {
            wide_screen_mode: true,
        },
        elements: [
            {
                tag: 'div',
                text: {
                    tag: 'lark_md',
                    content: isError ? `❌ ${message}` : `✅ ${message}`,
                },
            },
        ],
    }
}

/**
 * Format tool information for display
 */
function formatToolInfo(tool: string, args: unknown): string {
    if (!args || typeof args !== 'object') {
        return `**Tool:** ${tool}`
    }

    const argsObj = args as Record<string, unknown>
    let result = `**Tool:** ${tool}\n`

    switch (tool) {
        case 'Edit': {
            const file = String(argsObj.file_path || argsObj.path || 'unknown')
            result += `**File:** ${truncate(file, 100)}`
            break
        }
        case 'Write': {
            const file = String(argsObj.file_path || argsObj.path || 'unknown')
            const content = String(argsObj.content || '')
            result += `**File:** ${truncate(file, 100)}\n**Size:** ${content.length} chars`
            break
        }
        case 'Read': {
            const file = String(argsObj.file_path || argsObj.path || 'unknown')
            result += `**File:** ${truncate(file, 100)}`
            break
        }
        case 'Bash': {
            const cmd = String(argsObj.command || '')
            result += `**Command:** ${truncate(cmd, 150)}`
            break
        }
        case 'WebFetch': {
            const url = String(argsObj.url || '')
            result += `**URL:** ${truncate(url, 150)}`
            break
        }
        default: {
            const argStr = JSON.stringify(args)
            result += `**Args:** ${truncate(argStr, 200)}`
        }
    }

    return result
}

function truncate(str: string, maxLength: number): string {
    if (str.length <= maxLength) return str
    return str.slice(0, maxLength - 3) + '...'
}
