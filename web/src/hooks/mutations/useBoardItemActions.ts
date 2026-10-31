import { useCallback, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { BoardItem } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

function addUrl(current: ReadonlySet<string>, url: string): ReadonlySet<string> {
    if (current.has(url)) return current
    const next = new Set(current)
    next.add(url)
    return next
}

function removeUrl(current: ReadonlySet<string>, url: string): ReadonlySet<string> {
    if (!current.has(url)) return current
    const next = new Set(current)
    next.delete(url)
    return next
}

const EMPTY_URLS: ReadonlySet<string> = new Set()

/**
 * Close/reopen/comment/status-change/assignee-change for a to-do item — the
 * first write-capable piece of the to-do view (hapi#238). Every action
 * auto-invalidates the board's items query on success (operator requirement:
 * acting from HAPI reflects immediately, no manual refresh needed after a
 * write specifically) and throws on failure, same contract as
 * useBoardActions, leaving toast/dialog-error presentation to the caller.
 *
 * Pending state is tracked as a *set* of the acting items' urls, not a
 * single nullable one — one hook instance is shared across the whole board,
 * so two genuinely concurrent actions of the same kind (e.g. closing item A
 * while also closing item B, started before A's request settles) must both
 * be able to show as pending at once. A single-value slot (an earlier
 * version of this hook, Codex review: two passes) could only ever reflect
 * the most recently started one — guarding against a stale `finally`
 * clearing the WRONG item's slot fixed one symptom, but item A's button
 * still read as idle (and re-submittable) while A's own request was still
 * genuinely in flight, whenever B started after it.
 */
export function useBoardItemActions(api: ApiClient | null, boardId: string | null): {
    closeItem: (item: Pick<BoardItem, 'url'>) => Promise<void>
    reopenItem: (item: Pick<BoardItem, 'url'>) => Promise<void>
    commentOnItem: (item: Pick<BoardItem, 'url'>, body: string) => Promise<void>
    setItemStatus: (item: Pick<BoardItem, 'url'>, status: string | null) => Promise<void>
    setItemAssignees: (item: Pick<BoardItem, 'url'>, addLogins: string[], removeLogins: string[]) => Promise<void>
    closingUrls: ReadonlySet<string>
    reopeningUrls: ReadonlySet<string>
    commentingUrls: ReadonlySet<string>
    settingStatusUrls: ReadonlySet<string>
    settingAssigneesUrls: ReadonlySet<string>
} {
    const queryClient = useQueryClient()
    const [closingUrls, setClosingUrls] = useState<ReadonlySet<string>>(EMPTY_URLS)
    const [reopeningUrls, setReopeningUrls] = useState<ReadonlySet<string>>(EMPTY_URLS)
    const [commentingUrls, setCommentingUrls] = useState<ReadonlySet<string>>(EMPTY_URLS)
    const [settingStatusUrls, setSettingStatusUrls] = useState<ReadonlySet<string>>(EMPTY_URLS)
    const [settingAssigneesUrls, setSettingAssigneesUrls] = useState<ReadonlySet<string>>(EMPTY_URLS)

    // Invalidates every configured board's items cache, not just the one the
    // action was invoked on (Codex review, hapi#238): the same issue can be
    // a member of more than one board — an unfiltered project and one of its
    // saved views is an explicitly supported combination — and board queries
    // never poll, so a write from board A would otherwise leave board B
    // showing stale state (wrong status, wrong view membership) indefinitely.
    const invalidate = useCallback(() => {
        return queryClient.invalidateQueries({ queryKey: queryKeys.boardItemsAll })
    }, [queryClient])

    const requireTarget = useCallback((url: string | null) => {
        if (!api || !boardId) throw new Error('API unavailable')
        if (!url) throw new Error('This item has no linked issue or pull request to act on')
        return { api, boardId, url }
    }, [api, boardId])

    const closeItem = useCallback(async (item: Pick<BoardItem, 'url'>) => {
        const { api: client, boardId: id, url } = requireTarget(item.url)
        setClosingUrls(current => addUrl(current, url))
        try {
            await client.closeBoardItem(id, url)
            await invalidate()
        } finally {
            setClosingUrls(current => removeUrl(current, url))
        }
    }, [requireTarget, invalidate])

    const reopenItem = useCallback(async (item: Pick<BoardItem, 'url'>) => {
        const { api: client, boardId: id, url } = requireTarget(item.url)
        setReopeningUrls(current => addUrl(current, url))
        try {
            await client.reopenBoardItem(id, url)
            await invalidate()
        } finally {
            setReopeningUrls(current => removeUrl(current, url))
        }
    }, [requireTarget, invalidate])

    const commentOnItem = useCallback(async (item: Pick<BoardItem, 'url'>, body: string) => {
        const { api: client, boardId: id, url } = requireTarget(item.url)
        setCommentingUrls(current => addUrl(current, url))
        try {
            await client.commentOnBoardItem(id, url, body)
            await invalidate()
            await queryClient.invalidateQueries({ queryKey: queryKeys.boardItemComments(id, url) })
        } finally {
            setCommentingUrls(current => removeUrl(current, url))
        }
    }, [requireTarget, invalidate, queryClient])

    const setItemStatus = useCallback(async (item: Pick<BoardItem, 'url'>, status: string | null) => {
        const { api: client, boardId: id, url } = requireTarget(item.url)
        setSettingStatusUrls(current => addUrl(current, url))
        try {
            await client.setBoardItemStatus(id, url, status)
            await invalidate()
        } finally {
            setSettingStatusUrls(current => removeUrl(current, url))
        }
    }, [requireTarget, invalidate])

    const setItemAssignees = useCallback(async (item: Pick<BoardItem, 'url'>, addLogins: string[], removeLogins: string[]) => {
        const { api: client, boardId: id, url } = requireTarget(item.url)
        setSettingAssigneesUrls(current => addUrl(current, url))
        try {
            await client.setBoardItemAssignees(id, url, addLogins, removeLogins)
            await invalidate()
        } finally {
            setSettingAssigneesUrls(current => removeUrl(current, url))
        }
    }, [requireTarget, invalidate])

    return {
        closeItem, reopenItem, commentOnItem, setItemStatus, setItemAssignees,
        closingUrls, reopeningUrls, commentingUrls, settingStatusUrls, settingAssigneesUrls
    }
}
