import { useQuery } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'
import type { ApiClient } from '@/api/client'
import type { SlashCommand } from '@/types/api'
import type { Suggestion } from '@/hooks/useActiveSuggestions'
import { queryKeys } from '@/lib/query-keys'

/**
 * Built-in slash commands per agent type.
 * These are shown immediately without waiting for RPC.
 */
const BUILTIN_COMMANDS: Record<string, SlashCommand[]> = {
    claude: [
        { name: 'clear', description: 'Clear conversation history', source: 'builtin' },
        { name: 'compact', description: 'Compact conversation context', source: 'builtin' },
        { name: 'context', description: 'Show context information', source: 'builtin' },
        { name: 'cost', description: 'Show session cost', source: 'builtin' },
        { name: 'doctor', description: 'Run diagnostics', source: 'builtin' },
        { name: 'plan', description: 'Toggle plan mode', source: 'builtin' },
        { name: 'stats', description: 'Show session statistics', source: 'builtin' },
        { name: 'status', description: 'Show status', source: 'builtin' },
    ],
    codex: [
        { name: 'review', description: 'Review code', source: 'builtin' },
        { name: 'new', description: 'Start new conversation', source: 'builtin' },
        { name: 'compat', description: 'Check compatibility', source: 'builtin' },
        { name: 'undo', description: 'Undo last action', source: 'builtin' },
        { name: 'diff', description: 'Show changes', source: 'builtin' },
        { name: 'status', description: 'Show status', source: 'builtin' },
        { name: 'ps', description: 'Show processes', source: 'builtin' },
    ],
    gemini: [
        { name: 'about', description: 'About Gemini', source: 'builtin' },
        { name: 'clear', description: 'Clear conversation', source: 'builtin' },
        { name: 'compress', description: 'Compress context', source: 'builtin' },
        { name: 'stats', description: 'Show statistics', source: 'builtin' },
    ],
}

export function useSlashCommands(
    api: ApiClient | null,
    sessionId: string | null,
    agentType: string = 'claude'
): {
    commands: SlashCommand[]
    isLoading: boolean
    error: string | null
    getSuggestions: (query: string) => Promise<Suggestion[]>
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

    // Merge built-in commands with user-defined commands from API
    const commands = useMemo(() => {
        const builtin = BUILTIN_COMMANDS[agentType] ?? BUILTIN_COMMANDS['claude'] ?? []

        // If API succeeded, add user-defined commands
        if (query.data?.success && query.data.commands) {
            const userCommands = query.data.commands.filter(cmd => cmd.source === 'user')
            return [...builtin, ...userCommands]
        }

        // Fallback to built-in commands only
        return builtin
    }, [agentType, query.data])

    const getSuggestions = useCallback(async (queryText: string): Promise<Suggestion[]> => {
        // queryText will be like "/clea" - strip the leading slash
        const searchTerm = queryText.startsWith('/')
            ? queryText.slice(1).toLowerCase()
            : queryText.toLowerCase()

        return commands
            .filter(cmd => cmd.name.toLowerCase().startsWith(searchTerm))
            .map(cmd => ({
                key: `/${cmd.name}`,
                text: `/${cmd.name}`,
                label: `/${cmd.name}`,
                description: cmd.description ?? (cmd.source === 'user' ? 'Custom command' : undefined)
            }))
    }, [commands])

    return {
        commands,
        isLoading: query.isLoading,
        error: query.error instanceof Error ? query.error.message : query.error ? 'Failed to load commands' : null,
        getSuggestions,
    }
}
