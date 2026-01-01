import type { Session } from '../../sync/syncEngine'

interface SessionListCardParams {
    sessions: Session[]
    currentSessionId?: string
    chatId: string
}

export function buildSessionListCard(params: SessionListCardParams): unknown {
    const { sessions, currentSessionId } = params
    const activeCount = sessions.filter(s => s.active).length

    const elements: unknown[] = []

    if (sessions.length === 0) {
        elements.push({
            tag: 'markdown',
            content: '暂无 Session\n\n请在终端运行 `hapi start` 启动一个 Session'
        })
    } else {
        for (const session of sessions.slice(0, 10)) {
            const status = session.active ? '🟢' : '⚪'
            const isCurrent = session.id === currentSessionId
            const name = session.metadata?.name ||
                session.metadata?.path?.split('/').pop() ||
                session.id.slice(0, 8)
            const displayName = isCurrent ? `${name} ★` : name

            const agentType = session.metadata?.flavor || 'unknown'
            const agentEmoji = agentType === 'claude' ? '🤖' :
                agentType === 'gemini' ? '💎' :
                agentType === 'codex' ? '🔷' : '❓'

            const timeAgo = formatTimeAgo(session.activeAt)
            const path = session.metadata?.path || 'Unknown'

            elements.push({
                tag: 'markdown',
                content: [
                    `${status} **${displayName}**`,
                    `📁 \`${truncatePath(path, 40)}\``,
                    `${agentEmoji} ${capitalize(agentType)} · 🕐 ${timeAgo}`
                ].join('\n')
            })
            elements.push({ tag: 'hr' })
        }

        if (sessions.length > 10) {
            elements.push({
                tag: 'note',
                elements: [
                    { tag: 'plain_text', content: `... 还有 ${sessions.length - 10} 个 Session` }
                ]
            })
        }
    }

    return {
        config: { wide_screen_mode: true },
        header: {
            title: { tag: 'plain_text', content: `📋 Sessions (${activeCount} active / ${sessions.length} total)` },
            template: 'blue'
        },
        elements
    }
}

interface SessionInfoCardParams {
    session: Session
    messageCount: number
    isCurrent: boolean
}

export function buildSessionInfoCard(params: SessionInfoCardParams): unknown {
    const { session, messageCount, isCurrent } = params

    const name = session.metadata?.name ||
        session.metadata?.path?.split('/').pop() ||
        session.id.slice(0, 8)

    const status = session.active ? '🟢 Active' : '⚪ Inactive'
    const thinking = session.thinking ? '🤔 Thinking...' : '💤 Idle'
    const agentType = session.metadata?.flavor || 'unknown'
    const permissionMode = session.permissionMode || 'default'
    const branch = session.metadata?.worktree?.branch || '-'

    const elements: unknown[] = [
        { tag: 'markdown', content: `**ID:** \`${session.id}\`` },
        { tag: 'markdown', content: `**状态:** ${status}` },
        { tag: 'markdown', content: `**Agent:** ${capitalize(agentType)}` },
        { tag: 'markdown', content: `**权限模式:** ${permissionMode}` },
        { tag: 'markdown', content: `**工作目录:** \`${session.metadata?.path || 'Unknown'}\`` },
        { tag: 'markdown', content: `**Git 分支:** ${branch}` },
        { tag: 'markdown', content: `**创建时间:** ${formatDate(session.createdAt)}` },
        { tag: 'markdown', content: `**最后活跃:** ${formatTimeAgo(session.activeAt)}` },
        { tag: 'markdown', content: `**消息数:** ${messageCount}` },
        { tag: 'markdown', content: `**当前状态:** ${thinking}` },
    ]

    return {
        config: { wide_screen_mode: true },
        header: {
            title: { tag: 'plain_text', content: `📊 Session: ${name}` },
            subtitle: isCurrent ? { tag: 'plain_text', content: '当前绑定' } : undefined,
            template: session.active ? 'green' : 'grey'
        },
        elements
    }
}

function formatTimeAgo(timestamp: number): string {
    const now = Date.now()
    const diff = now - timestamp

    if (diff < 60_000) return '刚刚'
    if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`
    if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`
    return `${Math.floor(diff / 86400_000)} 天前`
}

function formatDate(timestamp: number): string {
    return new Date(timestamp).toLocaleString('zh-CN', { hour12: false })
}

function truncatePath(path: string, maxLen: number): string {
    if (path.length <= maxLen) return path
    return '...' + path.slice(-(maxLen - 3))
}

function capitalize(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1)
}
