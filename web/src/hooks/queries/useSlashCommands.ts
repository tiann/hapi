import { useQuery } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'
import type { ApiClient } from '@/api/client'
import type { SlashCommand } from '@/types/api'
import type { Suggestion } from '@/hooks/useActiveSuggestions'
import { queryKeys } from '@/lib/query-keys'
import { getBuiltinSlashCommands } from '@/lib/codexSlashCommands'

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

export function useSlashCommands(
    api: ApiClient | null,
    sessionId: string | null,
    agentType: string = 'claude',
    options?: { enabled?: boolean }
): {
    commands: SlashCommand[]
    isLoading: boolean
    error: string | null
    ensureCommands: () => Promise<SlashCommand[]>
    getSuggestions: (query: string) => Promise<Suggestion[]>
    suggestionsVersion: number
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
        enabled: Boolean(api && sessionId) && (options?.enabled ?? true),
        staleTime: 30_000,
        gcTime: 30 * 60 * 1000,
        refetchOnMount: true,
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
        retry: false, // Don't retry RPC failures
    })

    const mergeCommands = useCallback((data?: typeof query.data): SlashCommand[] => {
        const builtin = getBuiltinSlashCommands(agentType)

        // If API succeeded, add user-defined and plugin commands
        if (data?.success && data.commands) {
            const extraCommands = data.commands.filter(
                cmd => cmd.source === 'user' || cmd.source === 'plugin' || cmd.source === 'project'
            )
            return [...builtin, ...extraCommands]
        }

        // Fallback to built-in commands only
        return builtin
    }, [agentType])

    // Merge built-in commands with user-defined and plugin commands from API
    const commands = useMemo(() => mergeCommands(query.data), [mergeCommands, query.data])

    const ensureCommands = useCallback(async (): Promise<SlashCommand[]> => {
        let currentCommands = commands
        if (api && sessionId && (!query.data || query.isStale)) {
            const refreshed = await query.refetch()
            currentCommands = mergeCommands(refreshed.data)
        }
        return currentCommands
    }, [api, commands, mergeCommands, query, sessionId])

    const getSuggestions = useCallback(async (queryText: string): Promise<Suggestion[]> => {
        const searchTerm = queryText.startsWith('/')
            ? queryText.slice(1).toLowerCase()
            : queryText.toLowerCase()

        const currentCommands = query.isFetching ? commands : await ensureCommands()

        if (!searchTerm) {
            return currentCommands.map(cmd => ({
                key: `/${cmd.name}`,
                text: `/${cmd.name}`,
                label: `/${cmd.name}`,
                description: cmd.description ?? (cmd.source === 'builtin' ? undefined : 'Custom command'),
                content: cmd.content,
                source: cmd.source
            }))
        }

        const maxDistance = Math.max(2, Math.floor(searchTerm.length / 2))
        return currentCommands
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
                description: cmd.description ?? (cmd.source === 'builtin' ? undefined : 'Custom command'),
                content: cmd.content,
                source: cmd.source
            }))
    }, [commands, ensureCommands, query.isFetching])

    return {
        commands,
        isLoading: query.isLoading,
        error: query.error instanceof Error ? query.error.message : query.error ? 'Failed to load commands' : null,
        ensureCommands,
        getSuggestions,
        suggestionsVersion: query.dataUpdatedAt,
    }
}
