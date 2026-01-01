import type { CommandDefinition, CommandContext, ParsedArgs, CommandResult } from '../types'
import { buildSessionListCard, buildSessionInfoCard } from '../cards/sessionCards'

export const sessionsCommand: CommandDefinition = {
    name: 'hapi_sessions',
    aliases: ['sessions', 'list'],
    category: 'hapi',
    description: '列出所有 Session',
    usage: '/hapi_sessions [--active]',
    args: [
        {
            name: 'active',
            type: 'boolean',
            required: false,
            default: false,
            description: '仅显示活跃的 Session'
        }
    ],
    handler: async (ctx: CommandContext, args: ParsedArgs): Promise<CommandResult> => {
        const showActiveOnly = args.flags['active'] === true

        let sessions = ctx.syncEngine.getSessions()
        if (showActiveOnly) {
            sessions = sessions.filter(s => s.active)
        }

        sessions.sort((a, b) => b.activeAt - a.activeAt)

        const currentSessionId = ctx.getSessionForChat(ctx.chatId)

        const card = buildSessionListCard({
            sessions,
            currentSessionId,
            chatId: ctx.chatId
        })

        return {
            success: true,
            card
        }
    }
}

export const switchCommand: CommandDefinition = {
    name: 'hapi_switch',
    aliases: ['switch'],
    category: 'hapi',
    description: '切换到指定 Session',
    usage: '/hapi_switch <session_id|name>',
    args: [
        {
            name: 'target',
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
                error: '请指定 Session ID 或名称\n用法: /hapi_switch <session_id|name>'
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

        ctx.setSessionForChat(ctx.chatId, session.id)

        const sessionName = session.metadata?.name ||
            session.metadata?.path?.split('/').pop() ||
            session.id.slice(0, 8)

        return {
            success: true,
            message: `✅ 已切换到 Session: ${sessionName}`
        }
    }
}

export const infoCommand: CommandDefinition = {
    name: 'hapi_info',
    aliases: ['info'],
    category: 'hapi',
    description: '查看当前 Session 详情',
    usage: '/hapi_info [session_id]',
    args: [
        {
            name: 'session_id',
            type: 'string',
            required: false,
            description: 'Session ID（可选，默认当前 Session）'
        }
    ],
    handler: async (ctx: CommandContext, args: ParsedArgs): Promise<CommandResult> => {
        const targetId = args.positional[0] || ctx.getSessionForChat(ctx.chatId)

        if (!targetId) {
            return {
                success: false,
                error: '未绑定 Session，请先使用 /hapi_switch 切换到一个 Session'
            }
        }

        const session = ctx.syncEngine.getSession(targetId)
        if (!session) {
            return {
                success: false,
                error: `Session 不存在: ${targetId}`
            }
        }

        const messages = ctx.syncEngine.getSessionMessages(targetId)

        const card = buildSessionInfoCard({
            session,
            messageCount: messages.length,
            isCurrent: targetId === ctx.getSessionForChat(ctx.chatId)
        })

        return {
            success: true,
            card
        }
    }
}

export const sessionCommands = [sessionsCommand, switchCommand, infoCommand]
