import type { CommandDefinition, CommandContext, ParsedArgs, CommandResult } from '../types'
import { buildHistoryCard } from '../cards/historyCards'

export const historyCommand: CommandDefinition = {
    name: 'hapi_history',
    aliases: ['history'],
    category: 'hapi',
    description: '查看消息历史',
    usage: '/hapi_history [--limit <n>]',
    args: [
        {
            name: 'limit',
            type: 'number',
            required: false,
            default: 20,
            description: '显示的消息数量'
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

        const limit = typeof args.flags['limit'] === 'string'
            ? parseInt(args.flags['limit'], 10)
            : 20

        const messages = ctx.syncEngine.getSessionMessages(sessionId)
        const recentMessages = messages.slice(-limit)

        const card = buildHistoryCard({
            messages: recentMessages,
            sessionId,
            total: messages.length,
            limit
        })

        return {
            success: true,
            card
        }
    }
}

export const historyCommands = [historyCommand]
