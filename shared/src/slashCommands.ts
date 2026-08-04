import type { SlashCommand } from './apiTypes'

export const BUILTIN_SLASH_COMMANDS = {
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
        { name: 'agent', description: 'Toggle proactive Codex multi-agent delegation', source: 'builtin' },
        { name: 'clear', description: 'Clear current Codex thread context', source: 'builtin' },
        { name: 'compact', description: 'Compact current Codex thread context', source: 'builtin' },
        { name: 'goal', description: 'Set, view, pause, resume, or clear a persistent Codex goal', source: 'builtin' },
        { name: 'help', description: 'Show supported HAPI Codex slash commands', source: 'builtin' },
        { name: 'plan', description: 'Enable plan mode; use /plan off to return to default', source: 'builtin' },
        { name: 'default', description: 'Return Codex collaboration mode to default', source: 'builtin' },
        { name: 'execute', description: 'Return Codex collaboration mode to default', source: 'builtin' },
        { name: 'status', description: 'Show current Codex session config', source: 'builtin' },
        { name: 'model', description: 'Show or set Codex model, e.g. /model gpt-5.5', source: 'builtin' },
        { name: 'reasoning', description: 'Show or set reasoning effort', source: 'builtin' },
        { name: 'effort', description: 'Alias for /reasoning', source: 'builtin' },
        { name: 'personality', description: 'Show or set response style: friendly, pragmatic, or none', source: 'builtin' },
        { name: 'permissions', description: 'Show or set permission mode', source: 'builtin' },
        { name: 'permission', description: 'Alias for /permissions', source: 'builtin' },
    ],
    gemini: [
        { name: 'about', description: 'Show version info', source: 'builtin' },
        { name: 'clear', description: 'Clear the screen and conversation history', source: 'builtin' },
        { name: 'compress', description: 'Compress the context by replacing it with a summary', source: 'builtin' },
        { name: 'stats', description: 'Check session stats', source: 'builtin' },
    ],
    grok: [
        { name: 'compact', description: 'Compress conversation history to save context', source: 'builtin' },
        { name: 'context', description: 'Show context window usage and session stats', source: 'builtin' },
        { name: 'session-info', description: 'Show Grok session model, turns, and context usage', source: 'builtin' },
        { name: 'goal', description: 'Set, manage, or inspect an autonomous goal', source: 'builtin' },
        { name: 'always-approve', description: 'Toggle automatic tool approval', source: 'builtin' },
        { name: 'auto', description: 'Let Grok classify safe tool calls for automatic approval', source: 'builtin' },
    ],
    opencode: [
        { name: 'help', description: 'Show supported HAPI OpenCode slash commands', source: 'builtin' },
        { name: 'status', description: 'Show current OpenCode session config', source: 'builtin' },
        { name: 'plan', description: 'Enable plan mode; use /plan off to return to default', source: 'builtin' },
        { name: 'default', description: 'Return OpenCode permission mode to default', source: 'builtin' },
        { name: 'init', description: 'Generate or refresh AGENTS.md for this project', source: 'builtin' },
    ],
    cursor: [
        { name: 'compress', description: 'Compress conversation context to free window space (pass-through to Cursor agent)', source: 'builtin' },
    ],
    copilot: [
        { name: 'help', description: 'Show supported Copilot slash commands', source: 'builtin' },
        { name: 'status', description: 'Show current Copilot session config', source: 'builtin' },
        { name: 'plan', description: 'Start plan mode for structured implementation planning', source: 'builtin' },
        { name: 'autopilot', description: 'Start autopilot mode for autonomous multi-step work', source: 'builtin' },
        { name: 'fleet', description: 'Run parallel subagents for a task (combine with Interactive/Plan/Autopilot)', source: 'builtin' },
        { name: 'tasks', description: 'List or manage fleet tasks', source: 'builtin' },
        { name: 'subagents', description: 'Manage Copilot subagents', source: 'builtin' },
        { name: 'agents', description: 'Alias for /subagents', source: 'builtin' },
        { name: 'delegate', description: 'Delegate work to a subagent', source: 'builtin' },
        { name: 'agent', description: 'Select or configure a custom agent', source: 'builtin' },
        { name: 'rubber-duck', description: 'Consult the rubber-duck agent for a second opinion on plans, code, and tests', source: 'builtin' },
        { name: 'security-review', description: 'Run a focused security review of active local code changes', source: 'builtin' },
        { name: 'research', description: 'Run a deep research investigation across the codebase and web', source: 'builtin' },
        { name: 'review', description: 'Run the code-review agent on current changes', source: 'builtin' },
        { name: 'skills', description: 'List, inspect, add, or remove Copilot skills', source: 'builtin' },
        { name: 'context', description: 'Show current context usage', source: 'builtin' },
        { name: 'model', description: 'Show or switch the active model', source: 'builtin' },
        { name: 'permissions', description: 'Show or set permission mode', source: 'builtin' },
        { name: 'permission', description: 'Alias for /permissions', source: 'builtin' },
        { name: 'usage', description: 'Show session usage metrics', source: 'builtin' },
    ],
    kimi: [],
    pi: [],
} as const satisfies Record<string, readonly SlashCommand[]>

export function getBuiltinSlashCommands(agent: string): SlashCommand[] {
    const commands = BUILTIN_SLASH_COMMANDS[agent as keyof typeof BUILTIN_SLASH_COMMANDS]
        ?? BUILTIN_SLASH_COMMANDS.claude
    return commands.map((command) => ({ ...command }))
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
