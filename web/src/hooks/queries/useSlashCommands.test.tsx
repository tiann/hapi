import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useSlashCommands } from './useSlashCommands'
import { queryKeys } from '@/lib/query-keys'
import type { ApiClient } from '@/api/client'

function createWrapper(queryClient: QueryClient) {
    return function Wrapper({ children }: { children: ReactNode }) {
        return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    }
}

function createQueryClient() {
    return new QueryClient({
        defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
        },
    })
}

describe('useSlashCommands', () => {
    afterEach(() => {
        vi.restoreAllMocks()
        vi.clearAllMocks()
    })

    it('uses fresh cached session slash commands on mount without refetching the CLI', async () => {
        const queryClient = createQueryClient()
        queryClient.setQueryData(queryKeys.slashCommands('session-1'), {
            success: true,
            commands: [
                { name: 'cached-project-command', source: 'project', description: 'fresh cached command list' },
            ],
        })

        const api = {
            getSlashCommands: vi.fn(async () => ({
                success: true,
                commands: [
                    { name: 'superpowers:plan', source: 'plugin', description: 'new plugin command' },
                ],
            })),
        } as unknown as ApiClient

        const { result } = renderHook(() => useSlashCommands(api, 'session-1', 'codex'), {
            wrapper: createWrapper(queryClient),
        })

        await waitFor(() => {
            expect(result.current.commands.some((command) => command.name === 'cached-project-command')).toBe(true)
        })
        expect(api.getSlashCommands).not.toHaveBeenCalled()
    })

    it('can defer CLI slash command fetch until suggestions are requested', async () => {
        const queryClient = createQueryClient()
        const api = {
            getSlashCommands: vi.fn(async () => ({
                success: true,
                commands: [
                    { name: 'project-run', source: 'project', description: 'run project task' },
                ],
            })),
        } as unknown as ApiClient

        const { result } = renderHook(() => useSlashCommands(api, 'session-2', 'codex', { enabled: false }), {
            wrapper: createWrapper(queryClient),
        })

        expect(api.getSlashCommands).not.toHaveBeenCalled()

        const suggestions = await result.current.getSuggestions('/project')
        expect(api.getSlashCommands).toHaveBeenCalledTimes(1)
        expect(suggestions.map((item) => item.label)).toContain('/project-run')
    })

    it('can defer CLI slash command fetch until send validation needs the full command list', async () => {
        const queryClient = createQueryClient()
        const api = {
            getSlashCommands: vi.fn(async () => ({
                success: true,
                commands: [
                    { name: 'status', source: 'project', description: 'project status override' },
                ],
            })),
        } as unknown as ApiClient

        const { result } = renderHook(() => useSlashCommands(api, 'session-3', 'codex', { enabled: false }), {
            wrapper: createWrapper(queryClient),
        })

        expect(api.getSlashCommands).not.toHaveBeenCalled()

        const commands = await result.current.ensureCommands()
        expect(api.getSlashCommands).toHaveBeenCalledTimes(1)
        expect(commands).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'status', source: 'project' }),
        ]))
    })
})
