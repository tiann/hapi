import type { CommandDefinition, CommandContext, ParsedArgs, CommandResult } from '../types'
import { buildSwitchSessionCard } from '../cards/interactionCards'

export const bindCommand: CommandDefinition = {
    name: 'hapi_bind',
    aliases: [],
    category: 'hapi',
    description: '绑定当前群聊到 Session',
    usage: '/hapi_bind <session_id>',
    examples: ['/hapi_bind abc12345'],
    args: [
        {
            name: 'session_id',
            type: 'string',
            required: false,
            description: 'Session ID 或名称'
        }
    ],
    handler: async (ctx: CommandContext, args: ParsedArgs): Promise<CommandResult> => {
        const target = args.positional[0]
        const sessions = ctx.syncEngine.getSessions()
        sessions.sort((a, b) => b.activeAt - a.activeAt)

        if (!target) {
             if (sessions.length === 0) {
                return {
                    success: false,
                    error: '当前没有可用的 Session'
                }
            }
            const currentSessionId = ctx.getSessionForChat(ctx.chatId)
            return {
                success: true,
                card: buildSwitchSessionCard(sessions, currentSessionId)
            }
        }

        const session = sessions.find(s =>
            s.id === target ||
            s.id.startsWith(target) ||
            s.metadata?.name === target ||
            s.metadata?.path?.endsWith(target)
        )

        if (!session) {
            return {
                success: false,
                error: `未找到 Session: ${target}\n使用 /hapi_sessions 查看可用会话`
            }
        }

        const currentSessionId = ctx.getSessionForChat(ctx.chatId)
        if (currentSessionId === session.id) {
            const sessionName = session.metadata?.name ||
                session.metadata?.path?.split('/').pop() ||
                session.id.slice(0, 8)
            return {
                success: true,
                message: `ℹ️ 当前群聊已绑定到 Session: ${sessionName}`
            }
        }

        ctx.setSessionForChat(ctx.chatId, session.id)

        const sessionName = session.metadata?.name ||
            session.metadata?.path?.split('/').pop() ||
            session.id.slice(0, 8)

        return {
            success: true,
            message: `✅ 已绑定群聊到 Session: ${sessionName}\n\n后续消息将发送到此 Session，Agent 回复也会同步到此群聊。`
        }
    }
}

export const unbindCommand: CommandDefinition = {
    name: 'hapi_unbind',
    aliases: [],
    category: 'hapi',
    description: '解除当前群聊绑定',
    usage: '/hapi_unbind',
    examples: ['/hapi_unbind'],
    args: [],
    handler: async (ctx: CommandContext, _args: ParsedArgs): Promise<CommandResult> => {
        const currentSessionId = ctx.getSessionForChat(ctx.chatId)
        if (!currentSessionId) {
            return {
                success: false,
                error: '当前群聊未绑定任何 Session'
            }
        }

        const session = ctx.syncEngine.getSession(currentSessionId)
        const sessionName = session?.metadata?.name ||
            session?.metadata?.path?.split('/').pop() ||
            currentSessionId.slice(0, 8)

        ctx.unbindChat(ctx.chatId)

        return {
            success: true,
            message: `✅ 已解除与 Session "${sessionName}" 的绑定\n\n此群聊将不再接收该 Session 的消息。`
        }
    }
}

export const bindCommands = [bindCommand, unbindCommand]
