import { useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { CreateBoardItemRequest } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

export function useBoardActions(api: ApiClient | null): {
    addBoard: (url: string) => Promise<void>
    removeBoard: (boardId: string) => Promise<void>
    createBoardItem: (boardId: string, payload: CreateBoardItemRequest) => Promise<string>
} {
    const queryClient = useQueryClient()

    const addBoard = useCallback(async (url: string) => {
        if (!api) {
            throw new Error('API unavailable')
        }
        const response = await api.addBoard(url)
        queryClient.setQueryData(queryKeys.boards, response)
    }, [api, queryClient])

    const removeBoard = useCallback(async (boardId: string) => {
        if (!api) {
            throw new Error('API unavailable')
        }
        const response = await api.removeBoard(boardId)
        queryClient.setQueryData(queryKeys.boards, response)
        // The removed board's id can be reused (adding the same project URL
        // back produces the same deterministic id) — without evicting this,
        // React Query would briefly serve the pre-removal items for that id
        // from cache before any refetch completes.
        queryClient.removeQueries({ queryKey: queryKeys.boardItems(boardId) })
    }, [api, queryClient])

    // Dialog-owned flow (same contract as addBoard — throws on failure,
    // leaves error presentation to the caller's dialog state), not the
    // always-available fire-and-toast pattern useBoardItemActions uses for
    // existing-item actions: this is a one-shot, blocking "create" action
    // reviewed before submission, not a background mutation on an item
    // already on the board.
    const createBoardItem = useCallback(async (boardId: string, payload: CreateBoardItemRequest) => {
        if (!api) {
            throw new Error('API unavailable')
        }
        const response = await api.createBoardItem(boardId, payload)
        // GitHub Projects v2 has a real propagation lag between the hub's
        // own `gh project item-add` succeeding and the item actually
        // appearing in a subsequent items query — confirmed by hand:
        // missing from the very next fetch, present a few seconds and one
        // more fetch later. A single invalidate+refetch right after create
        // can race that lag and silently show the board without the
        // just-created item, reading as "the issue never got added" even
        // though it really was (operator report, hapi#247). Poll briefly
        // for the created item's own url to actually land, writing the
        // successful result straight into the cache, rather than a
        // one-shot refetch the operator has no way to know might lose that
        // race. `handleSubmit` keeps the dialog's "Creating…" state up for
        // however long this takes, so there's no silent gap in feedback.
        //
        // Best-effort: the issue and project-add writes already succeeded
        // above — a transient failure polling for them (network blip, hub
        // 502) must not surface as a creation failure (review finding,
        // both forks independently): NewCardDialog would show an error with
        // no sign the issue already exists, and a retry would file a
        // duplicate. Fall through to the plain invalidate on any polling
        // error, same as if polling had simply timed out without finding it.
        try {
            const deadline = Date.now() + 20_000
            let result = await api.getBoardItems(boardId)
            while (!result.items.some(item => item.url === response.url) && Date.now() < deadline) {
                await new Promise(resolve => setTimeout(resolve, 2000))
                result = await api.getBoardItems(boardId)
            }
            queryClient.setQueryData(queryKeys.boardItems(boardId), result)
        } catch {
            // Best-effort only — the create+add already succeeded.
        }
        // Still invalidate the all-boards prefix — the same issue can be a
        // member of more than one board (an unfiltered project and one of
        // its saved views), and only this one's cache was just hand-set.
        await queryClient.invalidateQueries({ queryKey: queryKeys.boardItemsAll })
        return response.url
    }, [api, queryClient])

    return { addBoard, removeBoard, createBoardItem }
}
