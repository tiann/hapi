import { commandRegistry } from './registry'
import { commandParser } from './parser'
import type { RouteResult, CommandContext, CommandResult, AgentType } from './types'

export class CommandRouter {
    private readonly HAPI_PREFIX = 'hapi_'

    route(text: string, agentType?: AgentType): RouteResult {
        const parsed = commandParser.parse(text)

        if (!parsed.isCommand) {
            return {
                type: 'passthrough',
                args: parsed.args,
                originalText: text
            }
        }

        if (parsed.prefix === '!' || parsed.prefix === '@') {
            return {
                type: 'passthrough',
                args: parsed.args,
                originalText: text
            }
        }

        const command = commandRegistry.get(parsed.command)

        if (parsed.command.startsWith(this.HAPI_PREFIX)) {
            if (command && command.category === 'hapi') {
                return {
                    type: 'hapi',
                    command,
                    args: parsed.args,
                    originalText: text
                }
            }
            return {
                type: 'unknown',
                args: parsed.args,
                originalText: text
            }
        }

        if (command && command.category === 'native') {
            if (command.agentTypes && agentType && !command.agentTypes.includes(agentType)) {
                return {
                    type: 'unknown',
                    args: parsed.args,
                    originalText: text
                }
            }
            return {
                type: 'native',
                command,
                args: parsed.args,
                originalText: text
            }
        }

        if (command && command.category === 'hapi') {
            return {
                type: 'hapi',
                command,
                args: parsed.args,
                originalText: text
            }
        }

        return {
            type: 'passthrough',
            args: parsed.args,
            originalText: text
        }
    }

    async execute(ctx: CommandContext, text: string): Promise<CommandResult> {
        const route = this.route(text, ctx.agentType)

        switch (route.type) {
            case 'hapi':
                if (route.command) {
                    return route.command.handler(ctx, route.args)
                }
                return { success: false, error: 'Command not found' }

            case 'native':
                return this.passToAgent(ctx, route.originalText)

            case 'passthrough':
                return this.passToAgent(ctx, route.originalText)

            case 'unknown':
                return {
                    success: false,
                    error: `未知命令: ${route.originalText.split(' ')[0]}\n使用 /help 查看可用命令`
                }
        }
    }

    private async passToAgent(ctx: CommandContext, text: string): Promise<CommandResult> {
        if (!ctx.sessionId) {
            return {
                success: false,
                error: '未绑定 Session，请先使用 /hapi_switch 切换到一个 Session'
            }
        }

        const isCommand = text.startsWith('/')

        await ctx.syncEngine.sendMessage(ctx.sessionId, {
            text,
            sentFrom: 'lark',
            messageType: isCommand ? 'command' : 'text'
        })

        return { success: true }
    }
}

export const commandRouter = new CommandRouter()
