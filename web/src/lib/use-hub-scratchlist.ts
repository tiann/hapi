import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { stripPreviewUrls } from '@hapi/protocol'
import type { ApiClient } from '@/api/client'
import { ApiError } from '@/api/client'
import { queryKeys } from '@/lib/query-keys'
import { extractScratchlistAttachmentMetadata } from '@/lib/scratchlistAttachmentAdapter'
import {
    getScratchlistAttachmentPreview,
    type ScratchlistAttachmentWithPreview,
} from '@/lib/scratchlistAttachmentPreview'
import {
    moveScratchlistEntry,
    persistScratchlist,
    readScratchlist,
    reorderScratchlistEntry,
    SCRATCHLIST_MAX_ENTRIES,
    SCRATCHLIST_MAX_TEXT_LENGTH,
    type ScratchlistEntry,
} from '@/lib/scratchlist'

/**
 * tiann/hapi#893 (scratchlist v2): hub-synced replacement for the v1
 * `useScratchlist` localStorage-only hook.
 *
 * Source-of-truth shift
 * ---------------------
 * v1: `localStorage` was canonical, persisted on every mutation, read on
 * mount. v2: hub becomes canonical (durable + cross-device); localStorage
 * is demoted to an offline cache. This hook fetches via TanStack Query
 * keyed by `queryKeys.scratchlist(sessionId)`; the SSE handler in
 * `useSSE.ts` invalidates that key when a `session-updated` patch
 * carries `scratchlistUpdatedAt`, so a write in tab A surfaces in tab B
 * within ~1 SSE round-trip.
 *
 * Optimistic mutations
 * --------------------
 * Add/delete/update apply optimistically to the cached entries list and
 * roll back on error using TanStack's `onMutate` / `onError` snapshot
 * pattern. The server returns the canonical row (with hub-stamped
 * `updatedAt`) on success and we reconcile.
 *
 * Reorder (move)
 * --------------
 * Reorder is persisted as a complete ordered id list on the hub. The
 * optimistic cache update keeps the panel responsive while the atomic hub
 * mutation and SSE invalidation make the order visible on other devices.
 *
 * Migration on first v2-load
 * --------------------------
 * When the hook mounts on a session that has localStorage entries from
 * v1 and the per-session migration flag has not been set, we push the
 * localStorage entries up via POST,
 * preserving their original `id` and `createdAt`. The flag
 * `hapi.scratchlist.v2.migrated.${sessionId}` then prevents repeated
 * migrations across reloads. The per-session banner status reflects
 * whether the migration just ran (`completed`) or was acknowledged
 * (`dismissed`); the banner component listens for this signal.
 */

const MIGRATION_FLAG_PREFIX = 'hapi.scratchlist.v2.migrated.'
const MIGRATION_BANNER_DISMISSED_PREFIX = 'hapi.scratchlist.v2.banner-dismissed.'

export type ScratchlistMigrationStatus =
    | 'idle'        // no localStorage entries; nothing to migrate
    | 'migrating'   // POSTs in flight
    | 'completed'   // migration ran (in this mount or a prior one) and
                    // the user has not yet dismissed the banner. The
                    // banner shows in this state, including across
                    // reloads, until the dismiss flag is written.
    | 'dismissed'   // banner was acknowledged; do not surface again

type HubEntry = {
    entryId: string
    text: string
    createdAt: number
    updatedAt: number
    position?: number
    attachments: ScratchlistAttachmentWithPreview[]
}

type ScratchlistResponse = { entries: HubEntry[] }

function readMigrationFlag(sessionId: string): boolean {
    if (typeof window === 'undefined') return false
    try {
        return window.localStorage.getItem(`${MIGRATION_FLAG_PREFIX}${sessionId}`) === '1'
    } catch {
        return false
    }
}

function writeMigrationFlag(sessionId: string): void {
    if (typeof window === 'undefined') return
    try {
        window.localStorage.setItem(`${MIGRATION_FLAG_PREFIX}${sessionId}`, '1')
    } catch {
        // Storage quota / private mode: non-fatal. Worst case the migration
        // re-runs next mount; the hub returns 200/duplicate for collisions
        // (see hub/src/store/scratchlist.ts createScratchlistEntry).
    }
}

function readBannerDismissed(sessionId: string): boolean {
    if (typeof window === 'undefined') return false
    try {
        return window.localStorage.getItem(`${MIGRATION_BANNER_DISMISSED_PREFIX}${sessionId}`) === '1'
    } catch {
        return false
    }
}

function writeBannerDismissed(sessionId: string): void {
    if (typeof window === 'undefined') return
    try {
        window.localStorage.setItem(`${MIGRATION_BANNER_DISMISSED_PREFIX}${sessionId}`, '1')
    } catch {
        // Non-fatal: banner reappears on next mount until storage works.
    }
}

/**
 * Convert hub entries into the in-memory shape the panel components
 * expect (`ScratchlistEntry` from `lib/scratchlist.ts`). Hub `entryId`
 * maps to local `id`; the timestamps remain available for cache and sync
 * reconciliation even though the row does not render a time indicator.
 */
function toLocalEntry(hub: HubEntry): ScratchlistEntry {
    return {
        id: hub.entryId,
        text: hub.text,
        createdAt: hub.createdAt,
        updatedAt: hub.updatedAt,
        position: hub.position,
        attachments: (hub.attachments ?? []).map((attachment) => {
            const previewUrl = getScratchlistAttachmentPreview(attachment)
            return previewUrl ? { ...attachment, previewUrl } : attachment
        })
    }
}

function isScratchlistNotFound(error: unknown): boolean {
    return error instanceof ApiError && error.status === 404
}

function makeOptimisticHubEntry(text: string, now: number): HubEntry {
    const fallbackId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `scratch-${now}-${Math.random().toString(36).slice(2, 10)}`
    return {
        entryId: fallbackId,
        text,
        createdAt: now,
        updatedAt: now,
        position: 0,
        attachments: []
    }
}

export function useHubScratchlist(
    sessionId: string,
    api: ApiClient | null
): {
    entries: ScratchlistEntry[]
    isLoading: boolean
    isUpdating: boolean
    add: (text: string, attachments?: import('@/types/api').AttachmentMetadata[]) => Promise<boolean>
    remove: (id: string) => Promise<void>
    update: (id: string, text: string, attachments?: ScratchlistAttachmentWithPreview[]) => Promise<void>
    move: (id: string, direction: 'up' | 'down') => void
    reorder: (id: string, targetIndex: number) => void
    migrationStatus: ScratchlistMigrationStatus
    dismissMigrationBanner: () => void
} {
    const queryClient = useQueryClient()
    // Stable identity: queryKeys.scratchlist() returns a fresh array
    // each call; without useMemo the migration effect's queryKey dep
    // changes every render and re-triggers after a failed POST clears
    // migrationAttemptedRef (tight retry loop on persistent 409/offline).
    const queryKey = useMemo(() => queryKeys.scratchlist(sessionId), [sessionId])
    const enabled = Boolean(api && sessionId)
    const migrationAttemptedRef = useRef(false)
    const [migrationStatus, setMigrationStatus] = useState<ScratchlistMigrationStatus>(() => {
        if (!sessionId) return 'idle'
        if (readBannerDismissed(sessionId)) return 'dismissed'
        // HAPI Bot, PR #896 follow-up: the migration flag alone does
        // NOT mean the operator saw the banner. If they reloaded
        // before clicking dismiss, they need to see it again on
        // remount - so 'completed' is sticky until the dismiss flag
        // is written. Sessions that had nothing to migrate write the
        // dismiss flag pre-emptively in the migration effect, so they
        // bypass this branch entirely and land in 'dismissed' above.
        if (readMigrationFlag(sessionId)) return 'completed'
        return 'idle'
    })

    const query = useQuery<ScratchlistResponse>({
        queryKey,
        queryFn: async () => {
            if (!api || !sessionId) {
                return { entries: [] }
            }
            return await api.getScratchlist(sessionId)
        },
        enabled,
        // 30s - matches `useSession` cache freshness so cross-tab SSE
        // invalidation is the dominant refresh signal, not stale-time
        // expiry.
        staleTime: 30_000,
    })

    // Reset migration tracking when the session id changes. The ref-based
    // gate prevents the migration effect from re-firing on every render
    // for the same session even if the query data fluctuates between
    // empty and non-empty during in-flight optimistic add/rollback.
    useEffect(() => {
        migrationAttemptedRef.current = false
        if (!sessionId) {
            setMigrationStatus('idle')
            return
        }
        if (readBannerDismissed(sessionId)) {
            setMigrationStatus('dismissed')
        } else if (readMigrationFlag(sessionId)) {
            // See useState init comment: migration-flag-set is the
            // 'banner shows until dismissed' state.
            setMigrationStatus('completed')
        } else {
            setMigrationStatus('idle')
        }
    }, [sessionId])

    // Migration trigger: runs ONCE per session when:
    //   - api is available
    //   - migration flag is unset
    //   - localStorage holds v1 entries
    // Hub being non-empty does NOT block the migration: each POST uses
    // the entry's original id and the route returns 200 for an
    // already-existing id (idempotent). So a session that another
    // device already populated is safely treated as a union with this
    // device's local entries. The actual POSTs are sequential to keep
    // retry semantics simple and to avoid bursts that could trip
    // rate-limit guards. For the typical case of "a handful of stale
    // entries" this is fine.
    useEffect(() => {
        if (!api || !sessionId) return
        if (migrationAttemptedRef.current) return
        if (query.isLoading || query.isFetching) return
        if (!query.data) return
        if (readMigrationFlag(sessionId)) return

        const localEntries = readScratchlist(sessionId)
        if (localEntries.length === 0) {
            // Nothing to migrate. Mark the session migrated AND
            // pre-dismiss the banner: there is no v1->v2 transition
            // to surface for this session, so the operator should not
            // see the banner at all (now or after a reload). The
            // init logic now treats migrationFlag-without-dismiss as
            // 'banner shows', so we have to opt this fresh-session
            // case out explicitly. Keeps the bot's PR #896 follow-up
            // banner-stickiness fix from spamming new sessions with
            // a migration banner they have nothing to migrate from.
            writeMigrationFlag(sessionId)
            writeBannerDismissed(sessionId)
            setMigrationStatus('dismissed')
            return
        }

        migrationAttemptedRef.current = true
        setMigrationStatus('migrating')

        void (async () => {
            // HAPI Bot review on PR #896 caught a data-loss path here:
            // swallowing per-entry POST failures and still writing the
            // migration flag would strand entries (the offline-cache
            // mirror would replace the original localStorage with the
            // partial hub state). Track failed entries and persist them
            // back so a future mount retries; do NOT set the flag until
            // every local entry is reconciled.
            const failedEntries: ScratchlistEntry[] = []
            try {
                // Preserve the localStorage order by sending each entry's
                // insertion index. The hub persists this as position.
                for (const [position, entry] of localEntries.entries()) {
                    const text = entry.text.length > SCRATCHLIST_MAX_TEXT_LENGTH
                        ? entry.text.slice(0, SCRATCHLIST_MAX_TEXT_LENGTH)
                        : entry.text
                    const attachments = stripPreviewUrls(entry.attachments ?? [])
                    if (text.trim().length === 0 && attachments.length === 0) continue
                    try {
                        await api.createScratchlistEntry(sessionId, {
                            text,
                            entryId: entry.id,
                            createdAt: entry.createdAt,
                            position: entry.position ?? position,
                            attachments
                        })
                    } catch {
                        // Genuine rejection (cap, network, 5xx...). The
                        // hub-side route returns 200 for duplicate
                        // entryId so an idempotent retry doesn't land
                        // here; only "really did not stick" failures do.
                        failedEntries.push({ ...entry, position: entry.position ?? position })
                    }
                }
                if (failedEntries.length > 0) {
                    // Write the unsynced subset back to localStorage so
                    // a future mount can retry them; leave the flag
                    // unset so the migration effect re-fires next time.
                    persistScratchlist(sessionId, failedEntries)
                    migrationAttemptedRef.current = false
                    setMigrationStatus('idle')
                    return
                }
                writeMigrationFlag(sessionId)
                await queryClient.invalidateQueries({ queryKey })
                setMigrationStatus('completed')
            } catch {
                // Whole-flow failure (network out, etc): persist the
                // entries that hadn't been attempted yet plus any that
                // failed up to the throw, leave the flag unset, and
                // clear the banner status so we don't show "completed"
                // for a half-done migration.
                if (failedEntries.length > 0) {
                    persistScratchlist(sessionId, failedEntries)
                }
                migrationAttemptedRef.current = false
                setMigrationStatus('idle')
            }
        })()
    }, [api, sessionId, query.data, query.isLoading, query.isFetching, queryClient, queryKey])

    const dismissMigrationBanner = useCallback(() => {
        writeBannerDismissed(sessionId)
        setMigrationStatus('dismissed')
    }, [sessionId])

    const addMutation = useMutation<
        { entry: HubEntry },
        Error,
        { text: string; attachments: ScratchlistAttachmentWithPreview[] },
        { previousData: ScratchlistResponse | undefined; optimisticEntryId: string }
    >({
        mutationFn: async ({ text, attachments }) => {
            if (!api || !sessionId) throw new Error('Scratchlist unavailable')
            return await api.createScratchlistEntry(sessionId, {
                text,
                attachments: stripPreviewUrls(attachments),
            })
        },
        onMutate: async ({ text, attachments }) => {
            await queryClient.cancelQueries({ queryKey })
            const previousData = queryClient.getQueryData<ScratchlistResponse>(queryKey)
            const optimistic = makeOptimisticHubEntry(text, Date.now())
            optimistic.attachments = attachments
            queryClient.setQueryData<ScratchlistResponse>(queryKey, (prev) => {
                const prior = prev?.entries ?? []
                return { entries: [optimistic, ...prior] }
            })
            return { previousData, optimisticEntryId: optimistic.entryId }
        },
        onError: (_error, _variables, context) => {
            // When previousData is missing (initial fetch cancelled before
            // populate), still drop the optimistic ghost so a rejected POST
            // cannot leave an unsaved note in the UI.
            if (context?.previousData !== undefined) {
                queryClient.setQueryData(queryKey, context.previousData)
                return
            }
            if (context?.optimisticEntryId) {
                queryClient.setQueryData<ScratchlistResponse>(queryKey, (prev) => ({
                    entries: (prev?.entries ?? []).filter((e) => e.entryId !== context.optimisticEntryId)
                }))
            }
        },
        onSuccess: (data, _variables, context) => {
            // Replace the optimistic entry with the hub-canonical row.
            // If SSE invalidation/refetch landed the canonical row before
            // POST resolved, also drop any existing row with the same
            // entryId so we do not show duplicates client-side.
            queryClient.setQueryData<ScratchlistResponse>(queryKey, (prev) => {
                if (!prev) return { entries: [data.entry] }
                const without = prev.entries.filter((e) =>
                    e.entryId !== context?.optimisticEntryId
                    && e.entryId !== data.entry.entryId
                )
                return { entries: [data.entry, ...without] }
            })
        }
    })

    const updateMutation = useMutation<
        { entry: HubEntry },
        Error,
        { entryId: string; text: string; attachments?: ScratchlistAttachmentWithPreview[] },
        { previousData: ScratchlistResponse | undefined }
    >({
        mutationFn: async ({ entryId, text, attachments }) => {
            if (!api || !sessionId) throw new Error('Scratchlist unavailable')
            return await api.updateScratchlistEntry(
                sessionId,
                entryId,
                text,
                attachments ? stripPreviewUrls(attachments) : undefined,
            )
        },
        onMutate: async ({ entryId, text, attachments }) => {
            await queryClient.cancelQueries({ queryKey })
            const previousData = queryClient.getQueryData<ScratchlistResponse>(queryKey)
            const now = Date.now()
            queryClient.setQueryData<ScratchlistResponse>(queryKey, (prev) => {
                if (!prev) return prev
                return {
                    entries: prev.entries.map((e) =>
                        e.entryId === entryId
                            ? { ...e, text, ...(attachments !== undefined ? { attachments } : {}), updatedAt: now }
                            : e
                    )
                }
            })
            return { previousData }
        },
        onError: (error, _variables, context) => {
            if (isScratchlistNotFound(error)) {
                queryClient.setQueryData<ScratchlistResponse>(queryKey, (prev) => {
                    if (!prev) return prev
                    return { entries: prev.entries.filter((e) => e.entryId !== _variables.entryId) }
                })
                void queryClient.invalidateQueries({ queryKey })
                return
            }
            if (context?.previousData !== undefined) {
                queryClient.setQueryData(queryKey, context.previousData)
            }
        },
        onSuccess: (data) => {
            // The optimistic edit uses the browser clock, while the Hub's
            // monotonic updatedAt is the revision token used by send cleanup.
            // Reconcile it before the row can be sent again.
            queryClient.setQueryData<ScratchlistResponse>(queryKey, (prev) => {
                if (!prev) return prev
                return {
                    entries: prev.entries.map((entry) =>
                        entry.entryId === data.entry.entryId ? data.entry : entry
                    )
                }
            })
        }
    })

    const deleteMutation = useMutation<
        void,
        Error,
        { entryId: string },
        { previousData: ScratchlistResponse | undefined }
    >({
        mutationFn: async ({ entryId }) => {
            if (!api || !sessionId) throw new Error('Scratchlist unavailable')
            await api.deleteScratchlistEntry(sessionId, entryId)
        },
        onMutate: async ({ entryId }) => {
            await queryClient.cancelQueries({ queryKey })
            const previousData = queryClient.getQueryData<ScratchlistResponse>(queryKey)
            queryClient.setQueryData<ScratchlistResponse>(queryKey, (prev) => {
                if (!prev) return prev
                return { entries: prev.entries.filter((e) => e.entryId !== entryId) }
            })
            return { previousData }
        },
        onError: (error, variables, context) => {
            if (isScratchlistNotFound(error)) {
                queryClient.setQueryData<ScratchlistResponse>(queryKey, (prev) => {
                    if (!prev) return prev
                    return { entries: prev.entries.filter((e) => e.entryId !== variables.entryId) }
                })
                void queryClient.invalidateQueries({ queryKey })
                return
            }
            if (context?.previousData !== undefined) {
                queryClient.setQueryData(queryKey, context.previousData)
            }
        }
    })

    const reorderMutation = useMutation<
        ScratchlistResponse,
        Error,
        HubEntry[],
        { previousData: ScratchlistResponse | undefined }
    >({
        scope: { id: `scratchlist-reorder:${sessionId}` },
        mutationFn: async (entries) => {
            if (!api || !sessionId) throw new Error('Scratchlist unavailable')
            return await api.reorderScratchlistEntries(
                sessionId,
                entries.map((entry) => entry.entryId)
            )
        },
        onMutate: async (entries) => {
            await queryClient.cancelQueries({ queryKey })
            const previousData = queryClient.getQueryData<ScratchlistResponse>(queryKey)
            queryClient.setQueryData<ScratchlistResponse>(queryKey, {
                entries: entries.map((entry, index) => ({ ...entry, position: index }))
            })
            return { previousData }
        },
        onError: (_error, _entries, context) => {
            if (context?.previousData !== undefined) {
                queryClient.setQueryData(queryKey, context.previousData)
            }
            void queryClient.invalidateQueries({ queryKey })
        },
        onSuccess: (data) => {
            queryClient.setQueryData(queryKey, data)
        }
    })

    const add = useCallback(async (
        rawText: string,
        composerAttachments?: import('@/types/api').AttachmentMetadata[]
    ): Promise<boolean> => {
        const text = rawText.trim()
        const attachments = extractScratchlistAttachmentMetadata(composerAttachments)
        if (text.length === 0 && attachments.length === 0) return false
        const truncated = text.length > SCRATCHLIST_MAX_TEXT_LENGTH
            ? text.slice(0, SCRATCHLIST_MAX_TEXT_LENGTH)
            : text
        const current = queryClient.getQueryData<ScratchlistResponse>(queryKey)?.entries ?? []
        if (current.length >= SCRATCHLIST_MAX_ENTRIES) {
            return false
        }
        try {
            await addMutation.mutateAsync({ text: truncated, attachments })
            return true
        } catch {
            return false
        }
    }, [addMutation, queryClient, queryKey])

    const remove = useCallback(async (id: string) => {
        try {
            await deleteMutation.mutateAsync({ entryId: id })
        } catch (error) {
            // A missing row is already reconciled by onError. Other failures
            // must reach the delete confirmation so it stays open and shows
            // the mutation error instead of disappearing as if it succeeded.
            if (!isScratchlistNotFound(error)) throw error
        }
    }, [deleteMutation])

    const updateEntry = useCallback(async (
        id: string,
        rawText: string,
        attachments?: ScratchlistAttachmentWithPreview[],
    ) => {
        const text = rawText.trim()
        if (text.length === 0 && (!attachments || attachments.length === 0)) return
        const truncated = text.length > SCRATCHLIST_MAX_TEXT_LENGTH
            ? text.slice(0, SCRATCHLIST_MAX_TEXT_LENGTH)
            : text
        try {
            await updateMutation.mutateAsync({ entryId: id, text: truncated, attachments })
        } catch (error) {
            // A missing row is reconciled by onError. Preserve other errors
            // for the confirmation path; inline editing catches this promise
            // at its event boundary because it has no error dialog.
            if (!isScratchlistNotFound(error)) throw error
        }
    }, [updateMutation])

    const move = useCallback((id: string, direction: 'up' | 'down') => {
        const current = queryClient.getQueryData<ScratchlistResponse>(queryKey)
        if (!current) return
        const reordered = moveScratchlistEntry(current.entries.map(toLocalEntry), id, direction)
        const byId = new Map(current.entries.map((entry) => [entry.entryId, entry] as const))
        const next = reordered
            .map((entry) => byId.get(entry.id))
            .filter((entry): entry is HubEntry => Boolean(entry))
        if (next.length !== current.entries.length) return
        if (next.every((entry, index) => entry.entryId === current.entries[index]?.entryId)) return
        reorderMutation.mutate(next)
    }, [queryClient, queryKey, reorderMutation])

    const reorder = useCallback((id: string, targetIndex: number) => {
        const current = queryClient.getQueryData<ScratchlistResponse>(queryKey)
        if (!current) return
        const reordered = reorderScratchlistEntry(current.entries.map(toLocalEntry), id, targetIndex)
        const byId = new Map(current.entries.map((entry) => [entry.entryId, entry] as const))
        const next = reordered
            .map((entry) => byId.get(entry.id))
            .filter((entry): entry is HubEntry => Boolean(entry))
        if (next.length !== current.entries.length) return
        if (next.every((entry, index) => entry.entryId === current.entries[index]?.entryId)) return
        reorderMutation.mutate(next)
    }, [queryClient, queryKey, reorderMutation])

    // Mirror entries into localStorage as an offline cache. Keeps the v1
    // surface (e.g. the standalone `ScratchlistPanel` used by tests)
    // working when offline, and protects against losing freshly-added
    // entries if the hub goes away mid-session.
    //
    // CRITICAL: gate on the migration flag. Pre-migration, localStorage
    // holds the v1 entries that the migration effect needs to read; if
    // we mirrored an empty hub fetch into localStorage on first render
    // we'd wipe the very entries we're about to upload (HAPI Bot
    // review on PR #896 caught a closely-related data-loss path). The
    // flag also stays unset on partial-failure migrations, which keeps
    // the failed-entry localStorage write from being clobbered.
    useEffect(() => {
        if (!sessionId) return
        if (!readMigrationFlag(sessionId)) return
        const data = query.data
        if (!data) return
        try {
            const cached = data.entries.map((e) => ({
                id: e.entryId,
                text: e.text,
                createdAt: e.createdAt,
                updatedAt: e.updatedAt,
                position: e.position,
                attachments: e.attachments?.map(({ previewUrl: _preview, ...attachment }) => attachment) ?? []
            }))
            window.localStorage.setItem(
                `hapi.scratchlist.v1.${sessionId}`,
                JSON.stringify(cached)
            )
        } catch {
            // Non-fatal: storage quota / private mode.
        }
    }, [sessionId, query.data, migrationStatus])

    const entries: ScratchlistEntry[] = (query.data?.entries ?? []).map(toLocalEntry)

    return {
        entries,
        isLoading: query.isLoading,
        isUpdating: updateMutation.isPending,
        add,
        remove,
        update: updateEntry,
        move,
        reorder,
        migrationStatus,
        dismissMigrationBanner
    }
}
