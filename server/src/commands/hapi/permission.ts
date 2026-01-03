import type { CommandDefinition, CommandContext, ParsedArgs, CommandResult } from '../types'

import { buildModeSelectionCard } from '../cards/interactionCards'

const PERMISSION_MODES = [
    'default', 'plan', 'read-only', 'acceptEdits',
    'safe-yolo', 'yolo', 'bypassPermissions'
] as const

export const approveCommand: CommandDefinition = {
    name: 'hapi_approve',
    aliases: ['y'],
    category: 'hapi',
    description: '批准权限请求',
    usage: '/hapi_approve [request_id]',
    examples: ['/hapi_approve', '/hapi_approve req_123'],
    args: [
        {
            name: 'request_id',
            type: 'string',
            required: false,
            description: '请求 ID（可选，默认批准最新请求）'
        }
    ],
    handler: async (ctx: CommandContext, args: ParsedArgs): Promise<CommandResult> => {
        const sessionId = ctx.sessionId || ctx.getSessionForChat(ctx.chatId)
        if (!sessionId) {
            return { success: false, error: '未绑定 Session' }
        }

        const session = ctx.syncEngine.getSession(sessionId)
        if (!session) {
            return { success: false, error: 'Session 不存在' }
        }

        const requests = session.agentState?.requests
        if (!requests || Object.keys(requests).length === 0) {
            return { success: false, error: '当前没有待处理的权限请求' }
        }

        const requestId = args.positional[0] || Object.keys(requests)[0]

        try {
            await ctx.syncEngine.approvePermission(sessionId, requestId)
            return { success: true, message: '✅ 已批准权限请求' }
        } catch (err) {
            return {
                success: false,
                error: `批准失败: ${err instanceof Error ? err.message : String(err)}`
            }
        }
    }
}

export const denyCommand: CommandDefinition = {
    name: 'hapi_deny',
    aliases: ['n'],
    category: 'hapi',
    description: '拒绝权限请求',
    usage: '/hapi_deny [request_id]',
    examples: ['/hapi_deny', '/hapi_deny req_123'],
    args: [
        {
            name: 'request_id',
            type: 'string',
            required: false,
            description: '请求 ID（可选，默认拒绝最新请求）'
        }
    ],
    handler: async (ctx: CommandContext, args: ParsedArgs): Promise<CommandResult> => {
        const sessionId = ctx.sessionId || ctx.getSessionForChat(ctx.chatId)
        if (!sessionId) {
            return { success: false, error: '未绑定 Session' }
        }

        const session = ctx.syncEngine.getSession(sessionId)
        if (!session) {
            return { success: false, error: 'Session 不存在' }
        }

        const requests = session.agentState?.requests
        if (!requests || Object.keys(requests).length === 0) {
            return { success: false, error: '当前没有待处理的权限请求' }
        }

        const requestId = args.positional[0] || Object.keys(requests)[0]

        try {
            await ctx.syncEngine.denyPermission(sessionId, requestId)
            return { success: true, message: '❌ 已拒绝权限请求' }
        } catch (err) {
            return {
                success: false,
                error: `拒绝失败: ${err instanceof Error ? err.message : String(err)}`
            }
        }
    }
}

export const modeCommand: CommandDefinition = {
    name: 'hapi_mode',
    aliases: [],
    category: 'hapi',
    description: '切换权限模式',
    usage: '/hapi_mode <mode>',
    examples: ['/hapi_mode auto', '/hapi_mode manual'],
    args: [
        {
            name: 'mode',
            type: 'enum',
            required: false,
            choices: [...PERMISSION_MODES],
            description: '权限模式'
        }
    ],
    handler: async (ctx: CommandContext, args: ParsedArgs): Promise<CommandResult> => {
        const mode = args.positional[0]
        const sessionId = ctx.getSessionForChat(ctx.chatId)

        if (!sessionId) {
            return { success: false, error: '未绑定 Session' }
        }

        const session = ctx.syncEngine.getSession(sessionId)
        if (!session) {
            return { success: false, error: 'Session 不存在' }
        }

        if (!mode) {
            const card = buildModeSelectionCard(session)
            return {
                success: true,
                card
            }
        }

        if (!PERMISSION_MODES.includes(mode as typeof PERMISSION_MODES[number])) {
            return {
                success: false,
                error: `无效的权限模式: ${mode}\n\n可用模式:\n${PERMISSION_MODES.map(m => `• ${m}`).join('\n')}`
            }
        }

        try {
            await ctx.syncEngine.setPermissionMode(sessionId, mode as typeof PERMISSION_MODES[number])
            return { success: true, message: `✅ 已切换到 ${mode} 模式` }
        } catch (err) {
            return {
                success: false,
                error: `切换失败: ${err instanceof Error ? err.message : String(err)}`
            }
        }
    }
}

export const permissionCommands = [approveCommand, denyCommand, modeCommand]
