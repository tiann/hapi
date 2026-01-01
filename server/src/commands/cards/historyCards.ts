import type { DecryptedMessage } from '../../sync/syncEngine'

interface HistoryCardParams {
    messages: DecryptedMessage[]
    sessionId: string
    total: number
    limit: number
}

export function buildHistoryCard(params: HistoryCardParams): unknown {
    const { messages, total, limit } = params

    const elements: unknown[] = []

    if (messages.length === 0) {
        elements.push({
            tag: 'markdown',
            content: '暂无消息历史'
        })
    } else {
        for (const msg of messages) {
            const content = msg.content as { role?: string; content?: { type?: string; text?: string; data?: unknown } }
            const role = content?.role || 'unknown'
            const roleEmoji = role === 'user' ? '👤' : role === 'agent' ? '🤖' : '📝'

            let text = ''
            if (content?.content?.type === 'text') {
                text = content.content.text || ''
            } else if (content?.content?.type === 'output') {
                const data = content.content.data as { type?: string; message?: { content?: string } }
                if (data?.type === 'user' && data?.message?.content) {
                    text = data.message.content
                } else {
                    text = '[Agent Output]'
                }
            } else {
                text = '[Message]'
            }

            const truncatedText = text.length > 100 ? text.slice(0, 100) + '...' : text
            const time = formatTime(msg.createdAt)

            elements.push({
                tag: 'markdown',
                content: `${roleEmoji} **${role}** _${time}_\n${escapeMarkdown(truncatedText)}`
            })
        }

        if (total > limit) {
            elements.push({
                tag: 'note',
                elements: [
                    { tag: 'plain_text', content: `显示最近 ${messages.length} 条，共 ${total} 条消息` }
                ]
            })
        }
    }

    return {
        config: { wide_screen_mode: true },
        header: {
            title: { tag: 'plain_text', content: `📜 消息历史 (${messages.length}/${total})` },
            template: 'blue'
        },
        elements
    }
}

function formatTime(timestamp: number): string {
    return new Date(timestamp).toLocaleTimeString('zh-CN', { hour12: false })
}

function escapeMarkdown(text: string): string {
    return text
        .replace(/\*/g, '\\*')
        .replace(/_/g, '\\_')
        .replace(/`/g, '\\`')
        .replace(/\n/g, ' ')
}
