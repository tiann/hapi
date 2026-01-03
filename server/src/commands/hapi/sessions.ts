import type { CommandDefinition, CommandContext, ParsedArgs, CommandResult } from '../types'
import { buildSessionListCard, buildSessionInfoCard } from '../cards/sessionCards'
import { buildSwitchSessionCard } from '../cards/interactionCards'

export const sessionsCommand: CommandDefinition = {
    name: 'hapi_sessions',
    aliases: ['s'],
    category: 'hapi',
    description: '列出所有 Session',
    usage: '/hapi_sessions [--active]',
    examples: ['/hapi_sessions', '/hapi_sessions --active'],
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
    aliases: ['sw'],
    category: 'hapi',
    description: '切换到指定 Session',
    usage: '/hapi_switch <session_id|name|编号>',
    examples: [
        '/hapi_switch 1          (切换到列表第1个)',
        '/hapi_switch cli        (切换到名为cli的会话)',
        '/hapi_switch abc12345   (切换到ID为abc12345的会话)'
    ],
    args: [
        {
            name: 'target',
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
                    error: '当前没有可用的 Session，请先使用 /hapi_new 创建'
                }
            }
            const currentSessionId = ctx.getSessionForChat(ctx.chatId)
            return {
                success: true,
                card: buildSwitchSessionCard(sessions, currentSessionId)
            }
        }

        let session = null
        const idx = parseInt(target, 10)
        if (!isNaN(idx) && idx >= 1 && idx <= sessions.length) {
            session = sessions[idx - 1]
        } else {
            session = sessions.find(s =>
                s.id === target ||
                s.id.startsWith(target) ||
                s.metadata?.name === target ||
                s.metadata?.path?.endsWith(target)
            )
        }

        if (!session) {
            return {
                success: false,
                error: `未找到 Session: ${target}\n使用 /hapi_sessions 查看可用会话`
            }
        }

        ctx.setSessionForChat(ctx.chatId, session.id)

        const messages = ctx.syncEngine.getSessionMessages(session.id)
        const card = buildSessionInfoCard({
            session,
            messageCount: messages.length,
            isCurrent: true
        })

        return {
            success: true,
            message: `✅ 已切换到 Session: ${session.id.slice(0, 8)}`, // Fallback text
            card
        }
    }
}

export const infoCommand: CommandDefinition = {
    name: 'hapi_info',
    aliases: ['i'],
    category: 'hapi',
    description: '查看当前 Session 详情',
    usage: '/hapi_info [session_id]',
    examples: ['/hapi_info', '/hapi_info abc12345'],
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
