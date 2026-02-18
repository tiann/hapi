import { useCallback } from 'react'
import type { ApiClient } from '@/api/client'
import type { Suggestion } from '@/hooks/useActiveSuggestions'

export function useFileSearch(
    api: ApiClient | null,
    sessionId: string | null
): {
    getSuggestions: (query: string) => Promise<Suggestion[]>
} {
    const getSuggestions = useCallback(async (queryText: string): Promise<Suggestion[]> => {
        const searchTerm = queryText.startsWith('@')
            ? queryText.slice(1)
            : queryText

        // Don't search with empty query — avoids listing every file
        if (!searchTerm || !api || !sessionId) {
            return []
        }

        try {
            const result = await api.searchSessionFiles(sessionId, searchTerm, 20)

            if (!result.success || !result.files) {
                return []
            }

            return result.files.map(file => ({
                key: file.fullPath,
                text: file.fullPath,
                label: file.fileName,
                description: file.filePath || undefined,
                source: 'builtin' as const
            }))
        } catch {
            return []
        }
    }, [api, sessionId])

    return { getSuggestions }
}
