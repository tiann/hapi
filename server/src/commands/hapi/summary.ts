import type { CommandDefinition, CommandContext, ParsedArgs, CommandResult } from '../types'

export const summaryCommand: CommandDefinition = {
    name: 'hapi_summary',
    aliases: ['summary'],
    category: 'hapi',
    description: '生成对话摘要',
    usage: '/hapi_summary [--limit <n>]',
    args: [
        {
            name: 'limit',
            type: 'number',
            required: false,
            default: 50,
            description: '摘要的消息数量'
        }
    ],
    handler: async (ctx: CommandContext, args: ParsedArgs): Promise<CommandResult> => {
        const sessionId = ctx.sessionId || ctx.getSessionForChat(ctx.chatId)
        if (!sessionId) {
            return {
                success: false,
                error: '未绑定 Session，请先使用 /hapi_switch 切换到一个 Session'
            }
        }

        const session = ctx.syncEngine.getSession(sessionId)
        if (!session) {
            return {
                success: false,
                error: 'Session 不存在'
            }
        }

        const limit = typeof args.flags['limit'] === 'string'
            ? parseInt(args.flags['limit'], 10)
            : 50

        const messages = ctx.syncEngine.getSessionMessages(sessionId)
        const recentMessages = messages.slice(-limit)

        if (recentMessages.length === 0) {
            return {
                success: true,
                message: '📝 暂无消息记录'
            }
        }

        const userMessages = recentMessages.filter(m => {
            const content = m.content
            return content && typeof content === 'object' && 'role' in content && content.role === 'user'
        })

        const assistantMessages = recentMessages.filter(m => {
            const content = m.content
            return content && typeof content === 'object' && 'role' in content && content.role === 'assistant'
        })

        const toolMessages = recentMessages.filter(m => {
            const content = m.content
            return content && typeof content === 'object' && 'role' in content && content.role === 'tool'
        })

        const sessionName = session.metadata?.name ||
            session.metadata?.path?.split('/').pop() ||
            session.id.slice(0, 8)

        const timeRange = recentMessages.length > 0
            ? `${formatTime(recentMessages[0].createdAt)} - ${formatTime(recentMessages[recentMessages.length - 1].createdAt)}`
            : '-'

        const topics = extractTopics(recentMessages)

        const summaryLines = [
            `📊 **Session 摘要: ${sessionName}**`,
            '',
            `**时间范围:** ${timeRange}`,
            `**消息统计:**`,
            `  • 用户消息: ${userMessages.length}`,
            `  • Agent 回复: ${assistantMessages.length}`,
            `  • 工具调用: ${toolMessages.length}`,
            `  • 总计: ${recentMessages.length}`,
            '',
        ]

        if (topics.length > 0) {
            summaryLines.push('**主要话题:**')
            topics.slice(0, 5).forEach(topic => {
                summaryLines.push(`  • ${topic}`)
            })
        }

        return {
            success: true,
            message: summaryLines.join('\n')
        }
    }
}

function formatTime(timestamp: number): string {
    return new Date(timestamp).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    })
}

interface MessageContent {
    role?: string
    text?: string
    content?: string
}

function extractTopics(messages: { content: unknown }[]): string[] {
    const topics: string[] = []

    for (const msg of messages) {
        const content = msg.content as MessageContent
        if (!content || typeof content !== 'object') continue
        if (content.role !== 'user') continue

        const text = content.text || content.content
        if (!text || typeof text !== 'string') continue

        const firstLine = text.split('\n')[0].trim()
        if (firstLine.length > 10 && firstLine.length < 100) {
            const truncated = firstLine.length > 50 ? firstLine.slice(0, 50) + '...' : firstLine
            if (!topics.includes(truncated)) {
                topics.push(truncated)
            }
        }
    }

    return topics
}

export const summaryCommands = [summaryCommand]
