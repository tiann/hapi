import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { IssueTemplate } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

const EMPTY_TEMPLATES: IssueTemplate[] = []

// `enabled` is driven by the caller (the "New card" dialog's own open state
// and repo-selection step), not just api/boardId/repo presence — fetching
// every configured repo's templates eagerly would mean a GraphQL call for
// data nobody may ever open the dialog to see.
//
// Always a live fetch, standard React Query staleTime defaults — no
// persistent cache across dialog opens (operator decision, hapi#238: a
// silently-stale issue-templates form is worse than one extra `gh api
// graphql` round trip). Memoization is purely incidental: picking between
// already-fetched repos within one open dialog reuses this same query
// instead of re-fetching, but reopening the dialog (or React Query's own
// garbage collection evicting the cache entry) always refetches live.
export function useIssueTemplates(
    api: ApiClient | null,
    boardId: string | null,
    repo: string | null,
    enabled: boolean
): {
    templates: IssueTemplate[]
    blankAllowed: boolean
    githubNewIssueUrl: string | null
    isLoading: boolean
    error: string | null
} {
    const query = useQuery({
        queryKey: queryKeys.issueTemplates(boardId ?? '', repo ?? ''),
        queryFn: async () => {
            if (!api || !boardId || !repo) {
                throw new Error('API unavailable')
            }
            return await api.getIssueTemplates(boardId, repo)
        },
        enabled: Boolean(api && boardId && repo && enabled),
        // Overrides the app's global 5s staleTime (web/src/lib/query-client.ts)
        // — this hook stays mounted at the router level with `enabled`
        // toggling, not actually unmounting between dialog opens, so without
        // this a reopen within that window is a cache hit that never even
        // starts a fetch (isFetching never flips true, stale data shown
        // forever within the window) — review finding on the first pass at
        // this bug, which only addressed the "fetch is in flight" display,
        // not "a fetch gets started at all."
        staleTime: 0,
        refetchOnMount: 'always',
    })

    return {
        // `isFetching`, not `isLoading`: the same board+repo pair queried
        // again within React Query's cache window (e.g. reopening the
        // dialog shortly after closing it) is a cache *hit* — `isLoading` is
        // false and `templates`/`blankAllowed` below would show that stale
        // cached data immediately while a live refetch runs silently in the
        // background. That's exactly the "silently-stale form" this hook's
        // own doc comment says never to allow (review finding) — `isFetching`
        // covers both the cold-cache and warm-cache-revalidating cases.
        templates: query.data?.templates ?? EMPTY_TEMPLATES,
        blankAllowed: query.data?.blankAllowed ?? true,
        githubNewIssueUrl: query.data?.githubNewIssueUrl ?? null,
        isLoading: query.isFetching,
        error: query.error instanceof Error ? query.error.message : query.error ? 'Failed to load issue templates' : null,
    }
}
