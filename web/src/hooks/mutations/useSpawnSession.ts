import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { SpawnResponse } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

type SpawnInput = {
    machineId: string
    directory: string
    agent?: 'claude' | 'codex' | 'gemini' | 'opencode'
    model?: string
    yolo?: boolean
    sessionType?: 'simple' | 'worktree'
    worktreeName?: string
    worktreeBranch?: string
}

export function useSpawnSession(api: ApiClient | null): {
    spawnSession: (input: SpawnInput) => Promise<SpawnResponse>
    isPending: boolean
    error: string | null
} {
    const queryClient = useQueryClient()

    const mutation = useMutation({
        mutationFn: async (input: SpawnInput) => {
            if (!api) {
                throw new Error('API unavailable')
            }
            return await api.spawnSession(
                input.machineId,
                input.directory,
                input.agent,
                input.model,
                input.yolo,
                input.sessionType,
                input.worktreeName,
                input.worktreeBranch
            )
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
