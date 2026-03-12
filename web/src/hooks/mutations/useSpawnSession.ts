import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { SpawnResponse } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

type SpawnInput = {
    machineId: string
    directory: string
    agent?: 'claude' | 'codex' | 'cursor' | 'gemini' | 'opencode'
    model?: string
    yolo?: boolean
    sessionType?: 'simple' | 'worktree'
    worktreeName?: string
}

export function useSpawnSession(api: ApiClient | null): {
    spawnSession: (input: SpawnInput) => Promise<SpawnResponse>
    isPending: boolean
    error: string | null
} {
    const queryClient = useQueryClient()

    const mutation = useMutation({
        mutationFn: async (input: SpawnInput) => {
            console.log('[Spawn] stage=request outcome=start', {
                machineId: input.machineId,
                directory: input.directory,
                agent: input.agent ?? 'claude',
                sessionType: input.sessionType ?? 'simple',
                worktreeName: input.worktreeName ?? null
            })

            if (!api) {
                console.error('[Spawn] stage=request outcome=error', {
                    cause: 'api_unavailable',
                    machineId: input.machineId
                })
                throw new Error('API unavailable')
            }

            try {
                const result = await api.spawnSession(
                    input.machineId,
                    input.directory,
                    input.agent,
                    input.model,
                    input.yolo,
                    input.sessionType,
                    input.worktreeName
                )

                if (result.type === 'success') {
                    console.log('[Spawn] stage=response outcome=success', {
                        machineId: input.machineId,
                        sessionId: result.sessionId
                    })
                } else {
                    console.error('[Spawn] stage=response outcome=error', {
                        cause: 'spawn_failed',
                        machineId: input.machineId,
                        message: result.message
                    })
                }

                return result
            } catch (error) {
                console.error('[Spawn] stage=request outcome=error', {
                    cause: 'network_or_exception',
                    machineId: input.machineId,
                    error: error instanceof Error ? error.message : String(error)
                })
                throw error
            }
        },
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
        },
    })

    return {
        spawnSession: mutation.mutateAsync,
        isPending: mutation.isPending,
        error: mutation.error instanceof Error ? mutation.error.message : mutation.error ? 'Failed to spawn session' : null,
    }
}
