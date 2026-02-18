import { useQuery } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'
import type { ApiClient } from '@/api/client'
import type { SlashCommand } from '@/types/api'
import type { Suggestion } from '@/hooks/useActiveSuggestions'
import { queryKeys } from '@/lib/query-keys'

function levenshteinDistance(a: string, b: string): number {
    if (a.length === 0) return b.length
    if (b.length === 0) return a.length
    const matrix: number[][] = []
    for (let i = 0; i <= b.length; i++) matrix[i] = [i]
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j
    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            matrix[i][j] = b[i - 1] === a[j - 1]
                ? matrix[i - 1][j - 1]
                : Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1)
        }
    }
    return matrix[b.length][a.length]
}

/**
 * Built-in slash commands per agent type.
 * These are shown immediately without waiting for RPC.
 */
const BUILTIN_COMMANDS: Record<string, SlashCommand[]> = {
    claude: [
        { name: 'clear', description: 'Clear conversation history and free up context', source: 'builtin' },
        { name: 'compact', description: 'Clear conversation history but keep a summary in context', source: 'builtin' },
        { name: 'context', description: 'Visualize current context usage as a colored grid', source: 'builtin' },
        { name: 'cost', description: 'Show the total cost and duration of the current session', source: 'builtin' },
        { name: 'doctor', description: 'Diagnose and verify your Claude Code installation and settings', source: 'builtin' },
        { name: 'new', description: 'Start a new chat during a conversation', source: 'builtin' },
        { name: 'plan', description: 'View or open the current session plan', source: 'builtin' },
        { name: 'stats', description: 'Show your Claude Code usage statistics and activity', source: 'builtin' },
        { name: 'status', description: 'Show Claude Code status including version, model, account, and API connectivity', source: 'builtin' },
    ],
    codex: [
        { name: 'clear', description: 'Clear conversation history and free up context', source: 'builtin' },
        { name: 'review', description: 'Review current changes and find issues', source: 'builtin' },
        { name: 'new', description: 'Start a new chat during a conversation', source: 'builtin' },
        { name: 'compat', description: 'Summarize conversation to prevent hitting the context limit', source: 'builtin' },
        { name: 'undo', description: 'Ask Codex to undo a turn', source: 'builtin' },
        { name: 'diff', description: 'Show git diff including untracked files', source: 'builtin' },
        { name: 'status', description: 'Show current session configuration and token usage', source: 'builtin' },
    ],
    gemini: [
        { name: 'about', description: 'Show version info', source: 'builtin' },
        { name: 'clear', description: 'Clear the screen and conversation history', source: 'builtin' },
        { name: 'compress', description: 'Compress the context by replacing it with a summary', source: 'builtin' },
        { name: 'new', description: 'Start a new chat during a conversation', source: 'builtin' },
        { name: 'stats', description: 'Check session stats', source: 'builtin' },
    ],
    opencode: [
        { name: 'new', description: 'Start a new chat during a conversation', source: 'builtin' },
    ],
}

/**
 * Descriptions for known Claude Code SDK slash commands.
 * These are merged from session.metadata.slashCommands when available.
 */
const SDK_COMMAND_DESCRIPTIONS: Record<string, string> = {
    'bug': 'Report bugs, issues, or feedback about Claude Code',
    'commit': 'Generate a git commit message and commit changes',
    'help': 'Get help with Claude Code commands and usage',
    'init': 'Initialize a CLAUDE.md project configuration file',
    'login': 'Log in to your Anthropic account',
    'logout': 'Log out of your Anthropic account',
    'mcp': 'Show MCP server status and available tools',
    'pr-review': 'Review a GitHub pull request',
    'review': 'Review current changes and find issues',
    'vim': 'Toggle vim keybinding mode',
}

export function useSlashCommands(
    api: ApiClient | null,
    sessionId: string | null,
    agentType: string = 'claude',
    sdkSlashCommands?: string[]
): {
    commands: SlashCommand[]
    isLoading: boolean
    isRefreshing: boolean
    error: string | null
    getSuggestions: (query: string) => Promise<Suggestion[]>
    refresh: () => Promise<void>
} {
    const resolvedSessionId = sessionId ?? 'unknown'

    // Fetch user-defined commands from the CLI (requires active session)
    const query = useQuery({
        queryKey: queryKeys.slashCommands(resolvedSessionId),
        queryFn: async () => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            return await api.getSlashCommands(sessionId)
        },
        enabled: Boolean(api && sessionId),
        staleTime: Infinity,
        gcTime: 30 * 60 * 1000,
        retry: false, // Don't retry RPC failures
    })

    // Merge built-in commands with user-defined, plugin, and SDK commands
    const commands = useMemo(() => {
        const builtin = BUILTIN_COMMANDS[agentType] ?? BUILTIN_COMMANDS['claude'] ?? []
        const allCommands = [...builtin]

        // If API succeeded, add user-defined and plugin commands
        if (query.data?.success && query.data.commands) {
            const extraCommands = query.data.commands.filter(
                cmd => cmd.source === 'user' || cmd.source === 'plugin'
            )
            allCommands.push(...extraCommands)
        }

        // Merge SDK slash commands that aren't already in the list
        if (sdkSlashCommands && sdkSlashCommands.length > 0) {
            const existingNames = new Set(allCommands.map(cmd => cmd.name))
            for (const name of sdkSlashCommands) {
                // SDK reports names with leading slash sometimes — normalize
                const cleanName = name.startsWith('/') ? name.slice(1) : name
                if (!existingNames.has(cleanName)) {
                    allCommands.push({
                        name: cleanName,
                        description: SDK_COMMAND_DESCRIPTIONS[cleanName],
                        source: 'builtin'
                    })
                    existingNames.add(cleanName)
                }
            }
        }

        return allCommands
    }, [agentType, query.data, sdkSlashCommands])

    const getSuggestions = useCallback(async (queryText: string): Promise<Suggestion[]> => {
        const searchTerm = queryText.startsWith('/')
            ? queryText.slice(1).toLowerCase()
            : queryText.toLowerCase()

        if (!searchTerm) {
            return commands.map(cmd => ({
                key: `/${cmd.name}`,
                text: `/${cmd.name}`,
                label: `/${cmd.name}`,
                description: cmd.description ?? (cmd.source === 'user' ? 'Custom command' : undefined),
                content: cmd.content,
                source: cmd.source
            }))
        }

        const maxDistance = Math.max(2, Math.floor(searchTerm.length / 2))
        return commands
            .map(cmd => {
                const name = cmd.name.toLowerCase()
                let score: number
                if (name === searchTerm) score = 0
                else if (name.startsWith(searchTerm)) score = 1
                else if (name.includes(searchTerm)) score = 2
                else {
                    const dist = levenshteinDistance(searchTerm, name)
                    score = dist <= maxDistance ? 3 + dist : Infinity
                }
                return { cmd, score }
            })
            .filter(item => item.score < Infinity)
            .sort((a, b) => a.score - b.score)
            .map(({ cmd }) => ({
                key: `/${cmd.name}`,
                text: `/${cmd.name}`,
                label: `/${cmd.name}`,
                description: cmd.description ?? (cmd.source === 'user' ? 'Custom command' : undefined),
                content: cmd.content,
                source: cmd.source
            }))
    }, [commands])

    return {
        commands,
        isLoading: query.isLoading,
        isRefreshing: query.isFetching,
        error: query.error instanceof Error ? query.error.message : query.error ? 'Failed to load commands' : null,
        getSuggestions,
        refresh: async () => {
            await query.refetch()
        },
    }
}
