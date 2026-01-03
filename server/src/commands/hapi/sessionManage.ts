import type { CommandDefinition, CommandContext, ParsedArgs, CommandResult } from '../types'

import { buildSessionCreateCard } from '../cards/sessionCreateCard'
import { buildCloseConfirmationCard, buildRenameCard } from '../cards/interactionCards'

const AGENT_TYPES = ['claude', 'gemini', 'codex'] as const

export const newSessionCommand: CommandDefinition = {
    name: 'hapi_new',
    aliases: [],
    category: 'hapi',
    description: '创建新 Session',
    usage: '/hapi_new [path] [machine] [--agent <type>] [--yolo]',
    examples: [
        '/hapi_new                         (在当前目录创建)',
        '/hapi_new /path/to/project        (指定目录)',
        '/hapi_new . mac-mini              (指定机器)',
        '/hapi_new . --agent gemini        (使用 Gemini Agent)'
    ],
    args: [
        {
            name: 'machine_id',
            type: 'string',
            required: false,
            description: 'Machine ID'
        },
        {
            name: 'directory',
            type: 'string',
            required: false,
            description: '工作目录路径'
        },
        {
            name: 'agent',
            type: 'enum',
            required: false,
            choices: [...AGENT_TYPES],
            description: 'Agent 类型'
        },
        {
            name: 'yolo',
            type: 'boolean',
            required: false,
            default: false,
            description: '启用 YOLO 模式'
        }
    ],
    handler: async (ctx: CommandContext, args: ParsedArgs): Promise<CommandResult> => {
        const machineId = args.positional[0]
        const directory = args.positional[1]

        // 如果没有提供参数，显示交互式创建卡片
        if (!machineId || !directory) {
            const machines = ctx.syncEngine.getOnlineMachines()
            const card = buildSessionCreateCard(machines)
            return {
                success: true,
                card
            }
        }

        const machine = ctx.syncEngine.getMachine(machineId) ||
            ctx.syncEngine.getMachines().find(m =>
                m.id.startsWith(machineId) ||
                (m.metadata?.host === machineId) // Updated property check
            )

        if (!machine) {
            return {
                success: false,
                error: `未找到 Machine: ${machineId}\n使用 /hapi_machines 查看可用机器`
            }
        }

        if (!machine.active) {
            return {
                success: false,
                error: `Machine ${machineId} 当前离线`
            }
        }

        const agentTypeRaw = args.flags['agent'] as string | undefined
        const agentType = agentTypeRaw as 'claude' | 'codex' | 'gemini' | undefined
        const yolo = args.flags['yolo'] === true

        try {
            const result = await ctx.syncEngine.spawnSession(
                machine.id,
                directory,
                agentType || 'claude',
                yolo
            )

            if (result.type === 'error') {
                return {
                    success: false,
                    error: `创建 Session 失败: ${result.message}`
                }
            }

            ctx.setSessionForChat(ctx.chatId, result.sessionId)

            return {
                success: true,
                message: [
                    '✅ Session 创建成功',
                    '',
                    `**Session ID:** \`${result.sessionId.slice(0, 8)}...\``,
                    `**工作目录:** \`${directory}\``,
                    `**Machine:** ${machine.metadata?.hostname || machine.id.slice(0, 8)}`,
                    agentType ? `**Agent:** ${agentType}` : '',
                    yolo ? '**模式:** YOLO' : '',
                    '',
                    '已自动绑定到当前群聊'
                ].filter(Boolean).join('\n')
            }
        } catch (err) {
            return {
                success: false,
                error: `创建 Session 失败: ${err instanceof Error ? err.message : String(err)}`
            }
        }
    }
}

export const closeSessionCommand: CommandDefinition = {
    name: 'hapi_close',
    aliases: [],
    category: 'hapi',
    description: '关闭 Session',
    usage: '/hapi_close [session_id]',
    examples: ['/hapi_close', '/hapi_close abc12345'],
    args: [
        {
            name: 'session_id',
            type: 'string',
            required: false,
            description: 'Session ID'
        }
    ],
    handler: async (ctx: CommandContext, args: ParsedArgs): Promise<CommandResult> => {
        let sessionId: string | undefined = args.positional[0]

        // 如果未指定 ID，默认使用当前绑定的 Session
        if (!sessionId) {
            sessionId = ctx.getSessionForChat(ctx.chatId) || undefined
            if (!sessionId) {
                return { success: false, error: '未指定 Session ID 且未绑定 Session' }
            }
            
            // 如果是无参调用，显示确认卡片
            const session = ctx.syncEngine.getSession(sessionId)
            if (session) {
                return {
                    success: true,
                    card: buildCloseConfirmationCard(session)
                }
            }
        }

        try {
            await ctx.syncEngine.abortSession(sessionId)
            
            // 如果关闭的是当前绑定的 Session，解除绑定
            const currentBound = ctx.getSessionForChat(ctx.chatId)
            if (currentBound === sessionId) {
                ctx.unbindChat(ctx.chatId)
            }
            
            return { success: true, message: `✅ Session ${sessionId} 已关闭` }
        } catch (err) {
            return {
                success: false,
                error: `关闭失败: ${err instanceof Error ? err.message : String(err)}`
            }
        }
    }
}

export const renameSessionCommand: CommandDefinition = {
    name: 'hapi_rename',
    aliases: [],
    category: 'hapi',
    description: '重命名 Session',
    usage: '/hapi_rename <new_name> [session_id]',
    examples: ['/hapi_rename my-project', '/hapi_rename backend-api abc12345'],
    args: [
        {
            name: 'new_name',
            type: 'string',
            required: false,
            description: '新名称'
        },
        {
            name: 'session_id',
            type: 'string',
            required: false,
            description: 'Session ID'
        }
    ],
    handler: async (ctx: CommandContext, args: ParsedArgs): Promise<CommandResult> => {
        const newName = args.positional[0]
        let sessionId: string | undefined = args.positional[1]

        if (!sessionId) {
            sessionId = ctx.getSessionForChat(ctx.chatId) || undefined
        }

        if (!sessionId) {
            return { success: false, error: '未指定 Session ID 且未绑定 Session' }
        }

        const session = ctx.syncEngine.getSession(sessionId)
        if (!session) {
            return { success: false, error: 'Session 不存在' }
        }

        // 如果未指定新名称，显示交互卡片
        if (!newName) {
            return {
                success: true,
                card: buildRenameCard(session)
            }
        }

        try {
            await ctx.syncEngine.renameSession(sessionId, newName)
            return { success: true, message: `✅ Session 已重命名为: ${newName}` }
        } catch (err) {
            return {
                success: false,
                error: `重命名失败: ${err instanceof Error ? err.message : String(err)}`
            }
        }
    }
}

export const sessionManageCommands = [newSessionCommand, closeSessionCommand, renameSessionCommand]
