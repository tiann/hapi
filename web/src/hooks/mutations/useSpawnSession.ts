import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRef } from 'react'
import type { ApiClient } from '@/api/client'
import type { PermissionMode, SpawnResponse } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

type SpawnInput = {
    machineId: string
    directory: string
    agent?: 'claude' | 'claude-deepseek' | 'claude-ark' | 'cc-api' | 'codex' | 'cursor' | 'agy' | 'grok' | 'opencode' | 'hermes-moa'
    model?: string
    effort?: string
    modelReasoningEffort?: string
    serviceTier?: string
    yolo?: boolean
    permissionMode?: PermissionMode
    sessionType?: 'simple' | 'worktree'
    worktreeName?: string
}

export function useSpawnSession(api: ApiClient | null): {
    spawnSession: (input: SpawnInput) => Promise<Exclude<SpawnResponse, { type: 'pending' | 'not_found' }>>
    isPending: boolean
    error: string | null
} {
    const queryClient = useQueryClient()
    const requestIds = useRef(new Map<string, string>())

    const mutation = useMutation({
        mutationFn: async (input: SpawnInput) => {
            if (!api) {
                throw new Error('API unavailable')
            }
            const fingerprint = JSON.stringify({
                machineId: input.machineId,
                directory: input.directory,
                agent: input.agent ?? null,
                model: input.model ?? null,
                effort: input.effort ?? null,
                modelReasoningEffort: input.modelReasoningEffort ?? null,
                serviceTier: input.serviceTier ?? null,
                yolo: input.yolo ?? null,
                permissionMode: input.permissionMode ?? null,
                sessionType: input.sessionType ?? null,
                worktreeName: input.worktreeName ?? null
            })
            const spawnRequestId = requestIds.current.get(fingerprint) ?? globalThis.crypto.randomUUID()
            requestIds.current.set(fingerprint, spawnRequestId)

            const submit = async () => await api.spawnSession(
                input.machineId,
                input.directory,
                input.agent,
                input.model,
                input.modelReasoningEffort,
                input.yolo,
                input.permissionMode,
                input.sessionType,
                input.worktreeName,
                input.effort,
                input.serviceTier,
                spawnRequestId
            )
            let result = await submit()

            const deadline = Date.now() + 120_000
            while ((result.type === 'pending' || result.type === 'not_found') && Date.now() < deadline) {
                if (result.type === 'not_found') {
                    result = await submit()
                } else {
                    await new Promise((resolve) => setTimeout(resolve, 750))
                    result = await api.querySpawnSession(input.machineId, spawnRequestId)
                }
            }
            if (result.type === 'pending' || result.type === 'not_found') {
                throw new Error(`Session is still starting (request ${spawnRequestId}). Retry to query the same request.`)
            }
            requestIds.current.delete(fingerprint)
            return result
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
