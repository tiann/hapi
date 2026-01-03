import type { CommandDefinition, CommandContext, ParsedArgs, CommandResult } from '../types'
import { buildMachineListCard } from '../cards/machineCards'
import { buildStatsCard, type StatsTab } from '../cards/statsCards'

const VERSION = '0.1.0'
const BUILD_TIME = new Date().toISOString().split('T')[0]

export const machinesCommand: CommandDefinition = {
    name: 'hapi_machines',
    aliases: [],
    category: 'hapi',
    description: '列出已连接的机器',
    usage: '/hapi_machines [--online]',
    examples: ['/hapi_machines', '/hapi_machines --online'],
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
    aliases: [],
    category: 'hapi',
    description: '查看系统统计',
    usage: '/hapi_stats [--tab <overview|models>]',
    examples: ['/hapi_stats', '/hapi_stats --tab models'],
    args: [
        {
            name: 'tab',
            type: 'enum',
            required: false,
            default: 'overview',
            choices: ['overview', 'models'],
            description: '显示的 Tab (overview 或 models)'
        }
    ],
    handler: async (ctx: CommandContext, args: ParsedArgs): Promise<CommandResult> => {
        const tab = (args.flags['tab'] as StatsTab) || 'overview'
        const sessions = ctx.syncEngine.getSessions()
        const machines = ctx.syncEngine.getMachines()
        const dbStats = ctx.syncEngine.getStats()

        const card = buildStatsCard({
            sessions,
            machines,
            dbStats
        }, tab)

        return {
            success: true,
            card
        }
    }
}

export const pingCommand: CommandDefinition = {
    name: 'hapi_ping',
    aliases: [],
    category: 'hapi',
    description: '检查连接状态',
    usage: '/hapi_ping',
    examples: ['/hapi_ping'],
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
    aliases: [],
    category: 'hapi',
    description: '查看版本信息',
    usage: '/hapi_version',
    examples: ['/hapi_version'],
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
