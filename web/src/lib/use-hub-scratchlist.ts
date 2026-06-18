import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import { queryKeys } from '@/lib/query-keys'
import {
    moveScratchlistEntry,
    persistScratchlist,
    readScratchlist,
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
 * Reorder is local-only in v2.0: the hub stores entries with stable
 * `createdAt` (used by future overseer queries per operator decision),
 * and adding a `position` column / cross-device order semantics is a
 * v2.1 concern. The move is applied to the cached array client-side; a
 * subsequent invalidation refetch will reset the order. This is a
 * documented limitation, not a bug - see `tiann/hapi#893` body.
 *
 * Migration on first v2-load
 * --------------------------
 * When the hook mounts on a session that has localStorage entries from
 * v1 AND the hub returns no entries AND the per-session migration flag
 * has not been set, we push the localStorage entries up via POST,
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
 * maps to local `id`. `updatedAt` is forwarded so the per-entry age
 * indicator (clock icon + tooltip) can render the smart-relative time
 * the operator asked for; v1 callers that don't render it just ignore
 * the field.
 */
function toLocalEntry(hub: HubEntry): ScratchlistEntry {
    return {
        id: hub.entryId,
        text: hub.text,
        createdAt: hub.createdAt,
        updatedAt: hub.updatedAt
    }
}

function makeOptimisticHubEntry(text: string, now: number): HubEntry {
    const fallbackId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `scratch-${now}-${Math.random().toString(36).slice(2, 10)}`
    return {
        entryId: fallbackId,
        text,
        createdAt: now,
        updatedAt: now
    }
}

export function useHubScratchlist(
    sessionId: string,
    api: ApiClient | null
): {
    entries: ScratchlistEntry[]
    isLoading: boolean
    add: (text: string) => Promise<boolean>
    remove: (id: string) => Promise<void>
    update: (id: string, text: string) => Promise<void>
    move: (id: string, direction: 'up' | 'down') => void
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
                // Preserve creation order by POSTing in the order
                // localStorage holds them. The hub orders by createdAt
                // DESC at read time, so source order doesn't actually
                // matter for visual layout - but we keep it deterministic
                // for the migration retry path.
                for (const entry of localEntries) {
                    const text = entry.text.length > SCRATCHLIST_MAX_TEXT_LENGTH
                        ? entry.text.slice(0, SCRATCHLIST_MAX_TEXT_LENGTH)
                        : entry.text
                    if (text.trim().length === 0) continue
                    try {
                        await api.createScratchlistEntry(sessionId, {
                            text,
                            entryId: entry.id,
                            createdAt: entry.createdAt
                        })
                    } catch {
                        // Genuine rejection (cap, network, 5xx...). The
                        // hub-side route returns 200 for duplicate
                        // entryId so an idempotent retry doesn't land
                        // here; only "really did not stick" failures do.
                        failedEntries.push(entry)
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
        { text: string },
        { previousData: ScratchlistResponse | undefined; optimisticEntryId: string }
    >({
        mutationFn: async ({ text }) => {
            if (!api || !sessionId) throw new Error('Scratchlist unavailable')
            return await api.createScratchlistEntry(sessionId, { text })
        },
        onMutate: async ({ text }) => {
            await queryClient.cancelQueries({ queryKey })
            const previousData = queryClient.getQueryData<ScratchlistResponse>(queryKey)
            const optimistic = makeOptimisticHubEntry(text, Date.now())
            queryClient.setQueryData<ScratchlistResponse>(queryKey, (prev) => {
                const prior = prev?.entries ?? []
                return { entries: [optimistic, ...prior] }
            })
            return { previousData, optimisticEntryId: optimistic.entryId }
        },
        onError: (_error, _variables, context) => {
            if (context?.previousData !== undefined) {
                queryClient.setQueryData(queryKey, context.previousData)
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
        { entryId: string; text: string },
        { previousData: ScratchlistResponse | undefined }
    >({
        mutationFn: async ({ entryId, text }) => {
            if (!api || !sessionId) throw new Error('Scratchlist unavailable')
            return await api.updateScratchlistEntry(sessionId, entryId, text)
        },
        onMutate: async ({ entryId, text }) => {
            await queryClient.cancelQueries({ queryKey })
            const previousData = queryClient.getQueryData<ScratchlistResponse>(queryKey)
            const now = Date.now()
            queryClient.setQueryData<ScratchlistResponse>(queryKey, (prev) => {
                if (!prev) return prev
                return {
                    entries: prev.entries.map((e) =>
                        e.entryId === entryId ? { ...e, text, updatedAt: now } : e
                    )
                }
            })
            return { previousData }
        },
        onError: (_error, _variables, context) => {
            if (context?.previousData !== undefined) {
                queryClient.setQueryData(queryKey, context.previousData)
            }
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
        onError: (_error, _variables, context) => {
            if (context?.previousData !== undefined) {
                queryClient.setQueryData(queryKey, context.previousData)
            }
        }
    })

    const add = useCallback(async (rawText: string): Promise<boolean> => {
        const text = rawText.trim()
        if (text.length === 0) return false
        const truncated = text.length > SCRATCHLIST_MAX_TEXT_LENGTH
            ? text.slice(0, SCRATCHLIST_MAX_TEXT_LENGTH)
            : text
        const current = queryClient.getQueryData<ScratchlistResponse>(queryKey)?.entries ?? []
        if (current.length >= SCRATCHLIST_MAX_ENTRIES) {
            return false
        }
        try {
            await addMutation.mutateAsync({ text: truncated })
            return true
        } catch {
            return false
        }
    }, [addMutation, queryClient, queryKey])

    const remove = useCallback(async (id: string) => {
        try {
            await deleteMutation.mutateAsync({ entryId: id })
        } catch {
            // Rollback already happened in onError; surface to caller via
            // the rejected promise would force the panel to add error UI
            // we don't have copy for. Swallow here; SSE refetch on next
            // hub state change will reconcile.
        }
    }, [deleteMutation])

    const updateEntry = useCallback(async (id: string, rawText: string) => {
        const text = rawText.trim()
        if (text.length === 0) return
        const truncated = text.length > SCRATCHLIST_MAX_TEXT_LENGTH
            ? text.slice(0, SCRATCHLIST_MAX_TEXT_LENGTH)
            : text
        try {
            await updateMutation.mutateAsync({ entryId: id, text: truncated })
        } catch {
            // see `remove` rationale.
        }
    }, [updateMutation])

    /**
     * Local-only reorder. Mutates the cached array so the UI updates
     * immediately; no hub call. The next invalidation refetch will reset
     * the order to `createdAt DESC` - documented limitation per
     * `tiann/hapi#893`. (v2.1 may add a `position` column.)
     */
    const move = useCallback((id: string, direction: 'up' | 'down') => {
        queryClient.setQueryData<ScratchlistResponse>(queryKey, (prev) => {
            if (!prev) return prev
            const local = prev.entries.map(toLocalEntry)
            const reordered = moveScratchlistEntry(local, id, direction)
            // Rebuild the hub-shaped list using the reordered ids while
            // preserving each entry's hub-stamped fields. Map by id for
            // O(1) lookup.
            const byId = new Map(prev.entries.map((e) => [e.entryId, e] as const))
            const next: HubEntry[] = []
            for (const r of reordered) {
                const hub = byId.get(r.id)
                if (hub) next.push(hub)
            }
            return { entries: next }
        })
    }, [queryClient, queryKey])

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
                updatedAt: e.updatedAt
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
        add,
        remove,
        update: updateEntry,
        move,
        migrationStatus,
        dismissMigrationBanner
    }
}
