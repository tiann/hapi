import type { CommandDefinition, CommandContext, CommandResult } from '../types'
import { buildModelSelectionCard, buildMcpListCard, buildStateCard, buildHapiStatusCard, buildHapiConfigCard, buildHapiUsageCard } from '../cards/interactionCards'

export const modelCommand: CommandDefinition = {
    name: 'model',
    aliases: [],
    category: 'agent',
    description: 'Select agent model',
    usage: '/model',
    examples: ['/model'],
    args: [],
    handler: async (ctx: CommandContext): Promise<CommandResult> => {
        if (!ctx.session) {
            return {
                success: false,
                error: 'No active session'
            }
        }
        return {
            success: true,
            card: buildModelSelectionCard(ctx.session)
        }
    }
}

export const mcpCommand: CommandDefinition = {
    name: 'mcp',
    aliases: [],
    category: 'agent',
    description: 'List MCP servers and tools',
    usage: '/mcp',
    examples: ['/mcp'],
    args: [],
    handler: async (ctx: CommandContext): Promise<CommandResult> => {
        if (!ctx.session) {
            return {
                success: false,
                error: 'No active session'
            }
        }

        const tools = ctx.session.metadata?.tools || []
        const mcpServers = tools.map(t => ({
            name: t,
            status: 'connected',
            tools: undefined
        }))

        return {
            success: true,
            card: buildMcpListCard(mcpServers)
        }
    }
}

export const stateCommand: CommandDefinition = {
    name: 'state',
    aliases: [],
    category: 'agent',
    description: 'Show agent internal state',
    usage: '/state',
    examples: ['/state'],
    args: [],
    handler: async (ctx: CommandContext): Promise<CommandResult> => {
        if (!ctx.session) {
            return {
                success: false,
                error: 'No active session'
            }
        }

        return {
            success: true,
            card: buildStateCard(ctx.session.agentState || {})
        }
    }
}

export const hapiStatusCommand: CommandDefinition = {
    name: 'hapi_status',
    aliases: [],
    category: 'hapi',
    description: 'Show HAPI session status',
    usage: '/hapi_status',
    examples: ['/hapi_status'],
    args: [],
    handler: async (ctx: CommandContext): Promise<CommandResult> => {
        if (!ctx.session) {
            return {
                success: false,
                error: 'No active session'
            }
        }
        return {
            success: true,
            card: buildHapiStatusCard(ctx.session)
        }
    }
}

export const hapiConfigCommand: CommandDefinition = {
    name: 'hapi_config',
    aliases: [],
    category: 'hapi',
    description: 'Show HAPI session config',
    usage: '/hapi_config',
    examples: ['/hapi_config'],
    args: [],
    handler: async (ctx: CommandContext): Promise<CommandResult> => {
        if (!ctx.session) {
            return {
                success: false,
                error: 'No active session'
            }
        }
        return {
            success: true,
            card: buildHapiConfigCard(ctx.session)
        }
    }
}

export const hapiUsageCommand: CommandDefinition = {
    name: 'hapi_usage',
    aliases: [],
    category: 'hapi',
    description: 'Show HAPI session usage',
    usage: '/hapi_usage',
    examples: ['/hapi_usage'],
    args: [],
    handler: async (ctx: CommandContext): Promise<CommandResult> => {
        if (!ctx.session) {
            return {
                success: false,
                error: 'No active session'
            }
        }
        return {
            success: true,
            card: buildHapiUsageCard(ctx.session)
        }
    }
}

export const statusCommand: CommandDefinition = {
    name: 'status',
    aliases: [],
    category: 'native',
    description: 'Show status (passthrough to client)',
    usage: '/status',
    examples: ['/status'],
    args: [],
    handler: async (ctx: CommandContext): Promise<CommandResult> => {
        if (!ctx.session) {
            return {
                success: false,
                error: 'No active session'
            }
        }
        return {
            success: true,
            card: buildHapiStatusCard(ctx.session)
        }
    }
}

export const configCommand: CommandDefinition = {
    name: 'config',
    aliases: [],
    category: 'native',
    description: 'Show config (passthrough to client)',
    usage: '/config',
    examples: ['/config'],
    args: [],
    handler: async (_ctx: CommandContext): Promise<CommandResult> => {
        return { success: true }
    }
}

export const usageCommand: CommandDefinition = {
    name: 'usage',
    aliases: [],
    category: 'native',
    description: 'Show usage (passthrough to client)',
    usage: '/usage',
    examples: ['/usage'],
    args: [],
    handler: async (_ctx: CommandContext): Promise<CommandResult> => {
        return { success: true }
    }
}

export const clientStatsCommand: CommandDefinition = {
    name: 'stats',
    aliases: [],
    category: 'native',
    description: 'Show stats (passthrough to client)',
    usage: '/stats',
    examples: ['/stats'],
    args: [],
    handler: async (ctx: CommandContext): Promise<CommandResult> => {
        if (!ctx.session) {
            return {
                success: false,
                error: 'No active session'
            }
        }

        await ctx.syncEngine.sendMessage(ctx.session.id, {
            text: '/stats',
            sentFrom: 'lark',
            messageType: 'command'
        })

        return {
            success: true
        }
    }
}

export const agentCommands = [
    modelCommand,
    mcpCommand,
    stateCommand,
    statusCommand,
    hapiStatusCommand,
    configCommand,
    hapiConfigCommand,
    usageCommand,
    hapiUsageCommand,
    clientStatsCommand
]
