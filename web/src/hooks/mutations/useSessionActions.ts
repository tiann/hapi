import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { ModelMode, PermissionMode } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

type PermissionModeValue = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'
type ModelModeValue = 'default' | 'sonnet' | 'opus'

function toPermissionMode(mode: PermissionMode): PermissionModeValue {
    if (mode === 'acceptEdits' || mode === 'bypassPermissions' || mode === 'plan') {
        return mode
    }
    return 'default'
}

function toModelMode(mode: ModelMode): ModelModeValue {
    if (mode === 'sonnet' || mode === 'opus') {
        return mode
    }
    return 'default'
}

export function useSessionActions(api: ApiClient | null, sessionId: string | null): {
    abortSession: () => Promise<void>
    setPermissionMode: (mode: PermissionMode) => Promise<void>
    setModelMode: (mode: ModelMode) => Promise<void>
    isPending: boolean
} {
    const queryClient = useQueryClient()

    const invalidateSession = async () => {
        if (!sessionId) return
        await queryClient.invalidateQueries({ queryKey: queryKeys.session(sessionId) })
        await queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
    }

    const abortMutation = useMutation({
        mutationFn: async () => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            await api.abortSession(sessionId)
        },
        onSuccess: () => void invalidateSession(),
    })

    const permissionMutation = useMutation({
        mutationFn: async (mode: PermissionMode) => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            await api.setPermissionMode(sessionId, toPermissionMode(mode))
        },
        onSuccess: () => void invalidateSession(),
    })

    const modelMutation = useMutation({
        mutationFn: async (mode: ModelMode) => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            await api.setModelMode(sessionId, toModelMode(mode))
        },
        onSuccess: () => void invalidateSession(),
    })

    return {
        abortSession: abortMutation.mutateAsync,
        setPermissionMode: permissionMutation.mutateAsync,
        setModelMode: modelMutation.mutateAsync,
        isPending: abortMutation.isPending || permissionMutation.isPending || modelMutation.isPending,
    }
}
