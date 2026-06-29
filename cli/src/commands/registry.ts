import chalk from 'chalk'
import { authCommand } from './auth'
import { claudeCommand } from './claude'
import { codexCommand } from './codex'
import { cursorCommand } from './cursor'
import { connectCommand } from './connect'
import { runnerCommand } from './runner'
import { resumeCommand } from './resume'
import { doctorCommand } from './doctor'
import { kimiCommand } from './kimi'
import { opencodeCommand } from './opencode'
import { piCommand } from './pi'
import { hookForwarderCommand } from './hookForwarder'
import { mcpCommand } from './mcp'
import { notifyCommand } from './notify'
import { hubCommand } from './hub'
import type { CommandContext, CommandDefinition } from './types'

// Gemini CLI was sunset (Google stopped serving the consumer Gemini CLI on
// 2026-06-18) so the agent is no longer launchable. Keep an explicit tombstone
// command so `hapi gemini` reports a clear error instead of falling through to
// the default Claude command with "gemini" as a forwarded argument.
const removedGeminiCommand: CommandDefinition = {
    name: 'gemini',
    requiresRuntimeAssets: false,
    run: async () => {
        console.error(
            chalk.red('Error:'),
            'Gemini CLI is no longer supported and cannot be launched (Google sunset the consumer Gemini CLI on 2026-06-18). Existing Gemini sessions remain viewable in the web UI.'
        )
        process.exit(1)
    }
}

const COMMANDS: CommandDefinition[] = [
    authCommand,
    connectCommand,
    codexCommand,
    cursorCommand,
    removedGeminiCommand,
    kimiCommand,
    opencodeCommand,
    piCommand,
    mcpCommand,
    hubCommand,
    { ...hubCommand, name: 'server' },
    hookForwarderCommand,
    doctorCommand,
    resumeCommand,
    runnerCommand,
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
