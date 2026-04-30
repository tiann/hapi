import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { EditorDirectoryResponse } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

export function useProjectDirectory(
    api: ApiClient | null,
    machineId: string | null,
    path: string | null,
    options?: {
        refetchInterval?: number | false
    }
): {
    entries: NonNullable<EditorDirectoryResponse['entries']>
    error: string | null
    isLoading: boolean
    refetch: () => Promise<unknown>
} {
    const resolvedMachineId = machineId ?? 'unknown'
    const resolvedPath = path ?? ''
    const enabled = Boolean(api && machineId && path)

    const query = useQuery({
        queryKey: queryKeys.editorDirectory(resolvedMachineId, resolvedPath),
        queryFn: async () => {
            if (!api || !machineId || !path) {
                throw new Error('Missing machineId or path')
            }

            const response = await api.listEditorDirectory(machineId, path)
            if (!response.success) {
                return { entries: [], error: response.error ?? 'Failed to list directory' }
            }

            return { entries: response.entries ?? [], error: null }
        },
        enabled,
        refetchInterval: options?.refetchInterval,
    })

    const queryError = query.error instanceof Error
        ? query.error.message
        : query.error
            ? 'Failed to list directory'
            : null

    return {
        entries: query.data?.entries ?? [],
        error: queryError ?? query.data?.error ?? null,
        isLoading: query.isLoading,
        refetch: query.refetch
    }
}
