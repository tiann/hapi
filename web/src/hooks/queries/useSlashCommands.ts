import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { ApiClient } from '@/api/client'
import type { SlashCommand, SlashCommandsResponse } from '@/types/api'
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
        { name: 'plan', description: 'View or open the current session plan', source: 'builtin' },
        { name: 'stats', description: 'Show your Claude Code usage statistics and activity', source: 'builtin' },
        { name: 'status', description: 'Show Claude Code status including version, model, account, and API connectivity', source: 'builtin' },
    ],
    codex: [
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
        { name: 'stats', description: 'Check session stats', source: 'builtin' },
    ],
    opencode: [],
}

type SlashFetchState = {
    hasFetchedSuccessfully: boolean
    lastFetchError: string | null
    lastEntryRefetchAt: number
}

const SLASH_ENTRY_COOLDOWN_MS = 4000

function getStateKey(sessionId: string | null, agentType: string): string {
    return `${sessionId ?? 'unknown'}::${agentType}`
}

function getOrCreateSlashFetchState(map: Map<string, SlashFetchState>, key: string): SlashFetchState {
    const existing = map.get(key)
    if (existing) return existing
    const created: SlashFetchState = {
        hasFetchedSuccessfully: false,
        lastFetchError: null,
        lastEntryRefetchAt: 0,
    }
    map.set(key, created)
    return created
}

function extractQueryError(queryError: unknown, queryData: SlashCommandsResponse | undefined): string | null {
    if (queryError instanceof Error) {
        return queryError.message
    }
    if (queryError) {
        return 'Failed to load commands'
    }
    if (queryData && queryData.success === false) {
        return queryData.error ?? 'Failed to load commands'
    }
    return null
}

export function mergeSlashCommands(
    builtin: SlashCommand[],
    remoteCommands: SlashCommand[] | undefined
): SlashCommand[] {
    const merged = [...builtin]
    const seenNames = new Set(builtin.map((command) => command.name.toLowerCase()))

    for (const command of remoteCommands ?? []) {
        if (command.source !== 'user' && command.source !== 'plugin' && command.source !== 'project') {
            continue
        }
        const normalizedName = command.name.toLowerCase()
        if (seenNames.has(normalizedName)) {
            continue
        }
        seenNames.add(normalizedName)
        merged.push(command)
    }

    return merged
}

export function shouldAttemptSlashEntryRefetch(
    state: SlashFetchState,
    now: number,
    cooldownMs: number = SLASH_ENTRY_COOLDOWN_MS
): boolean {
    if (!state.hasFetchedSuccessfully || state.lastFetchError !== null) {
        return true
    }
    return now - state.lastEntryRefetchAt >= cooldownMs
}

export function useSlashCommands(
    api: ApiClient | null,
    sessionId: string | null,
    agentType: string = 'claude'
): {
    commands: SlashCommand[]
    isLoading: boolean
    error: string | null
    isFetchingCommands: boolean
    getSuggestions: (query: string) => Promise<Suggestion[]>
    refetchCommands: () => Promise<void>
} {
    const resolvedSessionId = sessionId ?? 'unknown'
    const stateKey = getStateKey(sessionId, agentType)
    const stateBySessionRef = useRef<Map<string, SlashFetchState>>(new Map())
    const inFlightRefetchRef = useRef<Map<string, Promise<void>>>(new Map())

    // Fetch user-defined commands from the CLI (requires active session)
    const query = useQuery({
        queryKey: queryKeys.slashCommands(resolvedSessionId, agentType),
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

    useEffect(() => {
        const state = getOrCreateSlashFetchState(stateBySessionRef.current, stateKey)

        if (query.data?.success) {
            state.hasFetchedSuccessfully = true
            state.lastFetchError = null
            return
        }

        state.lastFetchError = extractQueryError(query.error, query.data)
    }, [query.data, query.error, stateKey])

    // Merge built-in commands with user-defined and plugin commands from API
    const commands = useMemo(() => {
        const builtin = BUILTIN_COMMANDS[agentType] ?? BUILTIN_COMMANDS['claude'] ?? []

        if (query.data?.success && query.data.commands) {
            return mergeSlashCommands(builtin, query.data.commands)
        }

        // Fallback to built-in commands only
        return builtin
    }, [agentType, query.data])

    const refetchCommands = useCallback(async (): Promise<void> => {
        if (!api || !sessionId) {
            return
        }

        const state = getOrCreateSlashFetchState(stateBySessionRef.current, stateKey)
        const now = Date.now()
        if (!shouldAttemptSlashEntryRefetch(state, now)) {
            return
        }

        const existingInFlight = inFlightRefetchRef.current.get(stateKey)
        if (existingInFlight) {
            await existingInFlight
            return
        }

        state.lastEntryRefetchAt = now

        const runRefetch = (async () => {
            try {
                const result = await query.refetch()
                if (result.data?.success) {
                    state.hasFetchedSuccessfully = true
                    state.lastFetchError = null
                } else {
                    state.lastFetchError = extractQueryError(result.error, result.data)
                }
            } catch (error) {
                state.lastFetchError = error instanceof Error ? error.message : 'Failed to load commands'
            } finally {
                inFlightRefetchRef.current.delete(stateKey)
            }
        })()

        inFlightRefetchRef.current.set(stateKey, runRefetch)
        await runRefetch
    }, [api, query, sessionId, stateKey])

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
        error: extractQueryError(query.error, query.data),
        isFetchingCommands: query.isFetching,
        getSuggestions,
        refetchCommands,
    }
}
