import type { SlashCommand } from '@/types/api'

const BUILTIN_COMMANDS: Record<string, SlashCommand[]> = {
    claude: [
        { name: 'clear', description: 'Clear conversation history and free up context', source: 'builtin' },
        { name: 'compact', description: 'Clear conversation history but keep a summary in context', source: 'builtin' },
        { name: 'context', description: 'Visualize current context usage as a colored grid', source: 'builtin' },
        { name: 'cost', description: 'Show the total cost and duration of the current session', source: 'builtin' },
        { name: 'doctor', description: 'Diagnose and verify your Claude Code installation and settings', source: 'builtin' },
        { name: 'plan', description: 'View or open the current session plan', source: 'builtin' },
        { name: 'stats', description: 'Show your Claude Code usage statistics and activity', source: 'builtin' },
        { name: 'status', description: 'Show Claude Code status including version, model, account, and API connectivity', source: 'builtin' },
    ],
    codex: [
        { name: 'clear', description: 'Clear current Codex thread context', source: 'builtin' },
        { name: 'compact', description: 'Compact current Codex thread context', source: 'builtin' },
        { name: 'help', description: 'Show supported HAPI Codex slash commands', source: 'builtin' },
        { name: 'plan', description: 'Enable plan mode; use /plan off to return to default', source: 'builtin' },
        { name: 'default', description: 'Return Codex collaboration mode to default', source: 'builtin' },
        { name: 'execute', description: 'Return Codex collaboration mode to default', source: 'builtin' },
        { name: 'status', description: 'Show current Codex session config', source: 'builtin' },
        { name: 'model', description: 'Show or set Codex model, e.g. /model gpt-5.5', source: 'builtin' },
        { name: 'reasoning', description: 'Show or set reasoning effort', source: 'builtin' },
        { name: 'effort', description: 'Alias for /reasoning', source: 'builtin' },
        { name: 'permissions', description: 'Show or set permission mode', source: 'builtin' },
        { name: 'permission', description: 'Alias for /permissions', source: 'builtin' },
    ],
    gemini: [
        { name: 'about', description: 'Show version info', source: 'builtin' },
        { name: 'clear', description: 'Clear the screen and conversation history', source: 'builtin' },
        { name: 'compress', description: 'Compress the context by replacing it with a summary', source: 'builtin' },
        { name: 'stats', description: 'Check session stats', source: 'builtin' },
    ],
    opencode: [],
}

const UNSUPPORTED_CODEX_BUILTIN_COMMANDS = new Set([
    'review',
    'new',
    'compat',
    'undo',
    'diff',
])

export function getBuiltinSlashCommands(agentType: string): SlashCommand[] {
    return BUILTIN_COMMANDS[agentType] ?? BUILTIN_COMMANDS.claude ?? []
}

export function mergeSlashCommands(commands: readonly SlashCommand[]): SlashCommand[] {
    const commandMap = new Map<string, SlashCommand>()
    for (const command of commands) {
        const key = command.name.toLowerCase()
        if (commandMap.has(key)) {
            commandMap.delete(key)
        }
        commandMap.set(key, command)
    }
    return Array.from(commandMap.values())
}

export function findCodexCustomPromptExpansion(
    text: string,
    availableCommands: readonly SlashCommand[]
): string | null {
    const trimmed = text.trim()
    const match = /^\/([a-z0-9:_-]+)$/i.exec(trimmed)
    if (!match) {
        return null
    }

    const commandName = match[1]?.toLowerCase()
    if (!commandName) {
        return null
    }

    const command = availableCommands.find(
        candidate => candidate.source !== 'builtin'
            && candidate.name.toLowerCase() === commandName
            && typeof candidate.content === 'string'
            && candidate.content.length > 0
    )
    return command?.content ?? null
}

export function findUnsupportedCodexBuiltinSlashCommand(
    text: string,
    availableCommands: readonly SlashCommand[]
): string | null {
    const match = /^\s*\/([a-z0-9:_-]+)(?:\s|$)/i.exec(text)
    if (!match) {
        return null
    }

    const commandName = match[1]?.toLowerCase()
    if (!commandName || !UNSUPPORTED_CODEX_BUILTIN_COMMANDS.has(commandName)) {
        return null
    }

    const hasCustomCommand = availableCommands.some(
        command => command.source !== 'builtin' && command.name.toLowerCase() === commandName
    )

    return hasCustomCommand ? null : commandName
}
