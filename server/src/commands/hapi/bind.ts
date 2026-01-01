import type { CommandDefinition, CommandContext, ParsedArgs, CommandResult } from '../types'

export const bindCommand: CommandDefinition = {
    name: 'hapi_bind',
    aliases: ['bind'],
    category: 'hapi',
    description: '绑定群聊到 Session',
    usage: '/hapi_bind <session_id>',
    args: [
        {
            name: 'session_id',
            type: 'string',
            required: true,
            description: 'Session ID 或名称'
        }
    ],
    handler: async (ctx: CommandContext, args: ParsedArgs): Promise<CommandResult> => {
        const target = args.positional[0]
        if (!target) {
            return {
                success: false,
                error: '请指定 Session ID 或名称\n用法: /hapi_bind <session_id>'
            }
        }

        const sessions = ctx.syncEngine.getSessions()
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
    aliases: ['unbind'],
    category: 'hapi',
    description: '解除群聊绑定',
    usage: '/hapi_unbind',
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
