import type { CommandDefinition, CommandContext, ParsedArgs, CommandResult } from '../types'
import { buildMachineListCard } from '../cards/machineCards'

const VERSION = '0.1.0'
const BUILD_TIME = new Date().toISOString().split('T')[0]

export const machinesCommand: CommandDefinition = {
    name: 'hapi_machines',
    aliases: ['machines'],
    category: 'hapi',
    description: '列出已连接机器',
    usage: '/hapi_machines [--online]',
    args: [
        {
            name: 'online',
            type: 'boolean',
            required: false,
            default: false,
            description: '仅显示在线机器'
        }
    ],
    handler: async (ctx: CommandContext, args: ParsedArgs): Promise<CommandResult> => {
        const onlineOnly = args.flags['online'] === true

        let machines = ctx.syncEngine.getMachines()
        if (onlineOnly) {
            machines = machines.filter(m => m.active)
        }

        machines.sort((a, b) => (b.activeAt || 0) - (a.activeAt || 0))

        const card = buildMachineListCard({ machines })

        return {
            success: true,
            card
        }
    }
}

export const statsCommand: CommandDefinition = {
    name: 'hapi_stats',
    aliases: ['stats'],
    category: 'hapi',
    description: '查看系统统计',
    usage: '/hapi_stats',
    args: [],
    handler: async (ctx: CommandContext, _args: ParsedArgs): Promise<CommandResult> => {
        const sessions = ctx.syncEngine.getSessions()
        const machines = ctx.syncEngine.getMachines()
        const bindings = ctx.getAllBindings()

        const activeSessions = sessions.filter(s => s.active).length
        const onlineMachines = machines.filter(m => m.active).length
        const thinkingSessions = sessions.filter(s => s.thinking).length

        const agentStats = sessions.reduce((acc, s) => {
            const agent = s.metadata?.flavor || 'unknown'
            acc[agent] = (acc[agent] || 0) + 1
            return acc
        }, {} as Record<string, number>)

        const statsLines = [
            '📊 **系统统计**',
            '',
            '**Sessions:**',
            `  • 总数: ${sessions.length}`,
            `  • 活跃: ${activeSessions}`,
            `  • 思考中: ${thinkingSessions}`,
            '',
            '**Machines:**',
            `  • 总数: ${machines.length}`,
            `  • 在线: ${onlineMachines}`,
            '',
            '**绑定:**',
            `  • 群聊绑定数: ${bindings.size}`,
            '',
            '**Agent 分布:**',
        ]

        for (const [agent, count] of Object.entries(agentStats)) {
            statsLines.push(`  • ${agent}: ${count}`)
        }

        return {
            success: true,
            message: statsLines.join('\n')
        }
    }
}

export const pingCommand: CommandDefinition = {
    name: 'hapi_ping',
    aliases: ['ping'],
    category: 'hapi',
    description: '检查连接状态',
    usage: '/hapi_ping',
    args: [],
    handler: async (ctx: CommandContext, _args: ParsedArgs): Promise<CommandResult> => {
        const startTime = Date.now()

        const connectionStatus = ctx.syncEngine.getConnectionStatus()
        const latency = Date.now() - startTime

        const sessions = ctx.syncEngine.getSessions()
        const machines = ctx.syncEngine.getMachines()
        const activeSessions = sessions.filter(s => s.active).length
        const onlineMachines = machines.filter(m => m.active).length

        const statusEmoji = connectionStatus === 'connected' ? '🟢' : '🔴'

        return {
            success: true,
            message: [
                `${statusEmoji} **HAPI Server**`,
                '',
                `**连接状态:** ${connectionStatus}`,
                `**响应延迟:** ${latency}ms`,
                `**活跃 Sessions:** ${activeSessions}/${sessions.length}`,
                `**在线 Machines:** ${onlineMachines}/${machines.length}`,
            ].join('\n')
        }
    }
}

export const versionCommand: CommandDefinition = {
    name: 'hapi_version',
    aliases: ['version', 'ver'],
    category: 'hapi',
    description: '显示版本信息',
    usage: '/hapi_version',
    args: [],
    handler: async (_ctx: CommandContext, _args: ParsedArgs): Promise<CommandResult> => {
        return {
            success: true,
            message: [
                '🤖 **HAPI - Human-AI Programming Interface**',
                '',
                `**版本:** v${VERSION}`,
                `**构建日期:** ${BUILD_TIME}`,
                '',
                '**支持的 Agent:**',
                '  • Claude (Anthropic)',
                '  • Gemini (Google)',
                '  • Codex (OpenAI)',
                '',
                '**文档:** https://github.com/anthropics/hapi',
            ].join('\n')
        }
    }
}

export const systemCommands = [machinesCommand, statsCommand, pingCommand, versionCommand]
