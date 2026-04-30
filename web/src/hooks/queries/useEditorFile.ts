import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import { queryKeys } from '@/lib/query-keys'

function decodeBase64Utf8(content: string): string {
    const binary = atob(content)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    return new TextDecoder().decode(bytes)
}

export function useEditorFile(
    api: ApiClient | null,
    machineId: string | null,
    filePath: string | null
): {
    content: string | null
    error: string | null
    isLoading: boolean
    refetch: () => Promise<unknown>
} {
    const resolvedMachineId = machineId ?? 'unknown'
    const resolvedFilePath = filePath ?? ''
    const enabled = Boolean(api && machineId && filePath)

    const query = useQuery({
        queryKey: queryKeys.editorFile(resolvedMachineId, resolvedFilePath),
        queryFn: async () => {
            if (!api || !machineId || !filePath) {
                throw new Error('Missing parameters')
            }

            const response = await api.readEditorFile(machineId, filePath)
            if (!response.success || !response.content) {
                return { content: null, error: response.error ?? 'Failed to read file' }
            }

            try {
                return { content: decodeBase64Utf8(response.content), error: null }
            } catch {
                return { content: null, error: 'Failed to decode file content' }
            }
        },
        enabled,
    })

    return {
        content: query.data?.content ?? null,
        error: query.error instanceof Error
            ? query.error.message
            : query.error
                ? 'Failed to read file'
                : query.data?.error ?? null,
        isLoading: query.isLoading,
        refetch: query.refetch
    }
}
