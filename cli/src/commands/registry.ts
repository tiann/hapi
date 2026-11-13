import chalk from 'chalk'
import type { CommandContext, CommandDefinition } from './types'

// Gemini CLI was sunset (Google stopped serving the consumer Gemini CLI on
// 2026-06-18) so the agent is no longer launchable. Keep an explicit tombstone
// command so `hapi gemini` explains why the agent is no longer available.
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

const commandMap = new Map<string, () => Promise<CommandDefinition>>([
    ['agy', async () => (await import('./agy')).agyCommand],
    ['auth', async () => (await import('./auth')).authCommand],
    ['claude', async () => (await import('./claude')).claudeCommand],
    ['connect', async () => (await import('./connect')).connectCommand],
    ['codex', async () => (await import('./codex')).codexCommand],
    ['dsh', async () => (await import('./dsh')).dshCommand],
    ['cursor', async () => (await import('./cursor')).cursorCommand],
    ['gemini', async () => removedGeminiCommand],
    ['grok', async () => (await import('./grok')).grokCommand],
    ['kimi', async () => (await import('./kimi')).kimiCommand],
    ['copilot', async () => (await import('./copilot')).copilotCommand],
    ['opencode', async () => (await import('./opencode')).opencodeCommand],
    ['pi', async () => (await import('./pi')).piCommand],
    ['mcp', async () => (await import('./mcp')).mcpCommand],
    ['mcp-proxy', async () => (await import('./mcpProxy')).mcpProxyCommand],
    ['hub', async () => (await import('./hub')).hubCommand],
    ['server', async () => ({ ...(await import('./hub')).hubCommand, name: 'server' })],
    ['hook-forwarder', async () => (await import('./hookForwarder')).hookForwarderCommand],
    ['doctor', async () => (await import('./doctor')).doctorCommand],
    ['resume', async () => (await import('./resume')).resumeCommand],
    ['runner', async () => (await import('./runner')).runnerCommand],
    ['notify', async () => (await import('./notify')).notifyCommand],
    ['ping-peer', async () => (await import('./pingPeer')).pingPeerCommand],
    ['inspect-peer', async () => (await import('./inspectPeer')).inspectPeerCommand],
    ['spawn-peer', async () => (await import('./spawnPeer')).spawnPeerCommand],
    ['set-mode', async () => (await import('./setMode')).setModeCommand],
    ['job', async () => (await import('./job')).jobCommand],
    ['usage', async () => (await import('./usage')).usageCommand]
])

export async function resolveCommand(args: string[]): Promise<{ command: CommandDefinition; context: CommandContext } | null> {
    const subcommand = args[0]
    const loadCommand = subcommand ? commandMap.get(subcommand) : undefined
    if (!loadCommand) return null
    const command = await loadCommand()

    return {
        command,
        context: {
            args,
            subcommand,
            commandArgs: args.slice(1)
        }
    }
}
