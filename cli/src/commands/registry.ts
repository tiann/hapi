import { authCommand } from './auth'
import { claudeCommand } from './claude'
import { codexCommand } from './codex'
import { connectCommand } from './connect'
import { daemonCommand } from './daemon'
import { doctorCommand } from './doctor'
import { geminiCommand } from './gemini'
import { hookForwarderCommand } from './hookForwarder'
import { logoutCommand } from './logout'
import { mcpCommand } from './mcp'
import { notifyCommand } from './notify'
import { serverCommand } from './server'
import type { CommandContext, CommandDefinition } from './types'

const COMMANDS: CommandDefinition[] = [
    authCommand,
    connectCommand,
    codexCommand,
    geminiCommand,
    mcpCommand,
    serverCommand,
    hookForwarderCommand,
    doctorCommand,
    daemonCommand,
    logoutCommand,
    notifyCommand
]

const commandMap = new Map<string, CommandDefinition>()
for (const command of COMMANDS) {
    commandMap.set(command.name, command)
}

export function resolveCommand(args: string[]): { command: CommandDefinition; context: CommandContext } {
    const subcommand = args[0]
    const command = subcommand ? commandMap.get(subcommand) : undefined
    const resolvedCommand = command ?? claudeCommand
    const commandArgs = command ? args.slice(1) : args

    return {
        command: resolvedCommand,
        context: {
            args,
            subcommand,
            commandArgs
        }
    }
}
