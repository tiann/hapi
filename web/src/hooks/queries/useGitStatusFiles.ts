import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { GitStatusFiles } from '@/types/api'
import { buildGitStatusFiles } from '@/lib/gitParsers'
import { queryKeys } from '@/lib/query-keys'

export function useGitStatusFiles(api: ApiClient | null, sessionId: string | null): {
    status: GitStatusFiles | null
    error: string | null
    isLoading: boolean
    refetch: () => Promise<unknown>
} {
    const resolvedSessionId = sessionId ?? 'unknown'
    const query = useQuery({
        queryKey: queryKeys.gitStatus(resolvedSessionId),
        queryFn: async () => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }

            const statusResult = await api.getGitStatus(sessionId)
            if (!statusResult.success) {
                return {
                    status: null,
                    error: statusResult.error ?? statusResult.stderr ?? 'Git status unavailable'
                }
            }

            const [unstagedResult, stagedResult] = await Promise.all([
                api.getGitDiffNumstat(sessionId, false),
                api.getGitDiffNumstat(sessionId, true)
            ])

            const status = buildGitStatusFiles(
                statusResult.stdout ?? '',
                unstagedResult.success ? (unstagedResult.stdout ?? '') : '',
                stagedResult.success ? (stagedResult.stdout ?? '') : ''
            )

            const errors: string[] = []
            if (!unstagedResult.success) {
                errors.push(`Unstaged diff unavailable: ${unstagedResult.error ?? unstagedResult.stderr ?? 'unknown error'}`)
            }
            if (!stagedResult.success) {
                errors.push(`Staged diff unavailable: ${stagedResult.error ?? stagedResult.stderr ?? 'unknown error'}`)
            }

            return { status, error: errors.length ? errors.join(' ') : null }
        },
        enabled: Boolean(api && sessionId),
    })

    const queryError = query.error instanceof Error
        ? query.error.message
        : query.error
            ? 'Git status unavailable'
            : null

    return {
        status: query.data?.status ?? null,
        error: queryError ?? query.data?.error ?? null,
        isLoading: query.isLoading,
        refetch: query.refetch
    }
}
