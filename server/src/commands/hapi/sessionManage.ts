import type { CommandDefinition, CommandContext, ParsedArgs, CommandResult } from '../types'

const AGENT_TYPES = ['claude', 'gemini', 'codex'] as const

export const newCommand: CommandDefinition = {
    name: 'hapi_new',
    aliases: ['new'],
    category: 'hapi',
    description: '创建新 Session',
    usage: '/hapi_new <machine_id> <directory> [--agent <type>] [--yolo]',
    args: [
        {
            name: 'machine_id',
            type: 'string',
            required: true,
            description: 'Machine ID'
        },
        {
            name: 'directory',
            type: 'string',
            required: true,
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

        if (!machineId || !directory) {
            return {
                success: false,
                error: '请指定 Machine ID 和工作目录\n用法: /hapi_new <machine_id> <directory>'
            }
        }

        const machine = ctx.syncEngine.getMachine(machineId) ||
            ctx.syncEngine.getMachines().find(m =>
                m.id.startsWith(machineId) ||
                m.metadata?.hostname === machineId
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

export const closeCommand: CommandDefinition = {
    name: 'hapi_close',
    aliases: ['close'],
    category: 'hapi',
    description: '关闭 Session',
    usage: '/hapi_close [session_id]',
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
                error: '请指定 Session ID 或先绑定一个 Session'
            }
        }

        const session = ctx.syncEngine.getSession(targetId)
        if (!session) {
            return {
                success: false,
                error: `Session 不存在: ${targetId}`
            }
        }

        const sessionName = session.metadata?.name ||
            session.metadata?.path?.split('/').pop() ||
            session.id.slice(0, 8)

        try {
            await ctx.syncEngine.abortSession(targetId)

            const currentSessionId = ctx.getSessionForChat(ctx.chatId)
            if (currentSessionId === targetId) {
                ctx.unbindChat(ctx.chatId)
            }

            return {
                success: true,
                message: `✅ 已关闭 Session: ${sessionName}`
            }
        } catch (err) {
            return {
                success: false,
                error: `关闭 Session 失败: ${err instanceof Error ? err.message : String(err)}`
            }
        }
    }
}

export const renameCommand: CommandDefinition = {
    name: 'hapi_rename',
    aliases: ['rename'],
    category: 'hapi',
    description: '重命名 Session',
    usage: '/hapi_rename <new_name> [session_id]',
    args: [
        {
            name: 'new_name',
            type: 'string',
            required: true,
            description: '新名称'
        },
        {
            name: 'session_id',
            type: 'string',
            required: false,
            description: 'Session ID（可选，默认当前 Session）'
        }
    ],
    handler: async (ctx: CommandContext, args: ParsedArgs): Promise<CommandResult> => {
        const newName = args.positional[0]
        const targetId = args.positional[1] || ctx.getSessionForChat(ctx.chatId)

        if (!newName) {
            return {
                success: false,
                error: '请指定新名称\n用法: /hapi_rename <new_name>'
            }
        }

        if (!targetId) {
            return {
                success: false,
                error: '请指定 Session ID 或先绑定一个 Session'
            }
        }

        const session = ctx.syncEngine.getSession(targetId)
        if (!session) {
            return {
                success: false,
                error: `Session 不存在: ${targetId}`
            }
        }

        const oldName = session.metadata?.name ||
            session.metadata?.path?.split('/').pop() ||
            session.id.slice(0, 8)

        if (session.metadata) {
            session.metadata.name = newName
        }

        return {
            success: true,
            message: `✅ 已将 Session "${oldName}" 重命名为 "${newName}"`
        }
    }
}

export const sessionManageCommands = [newCommand, closeCommand, renameCommand]
