import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { ApiClient } from '@/api/client'
import { ApiError } from '@/api/client'
import { useHubScratchlist } from './use-hub-scratchlist'
import { queryKeys } from './query-keys'

/**
 * Tests for the v2 hub-backed scratchlist hook (tiann/hapi#893).
 * Covers:
 *   - initial fetch
 *   - optimistic add + rollback on error
 *   - optimistic delete + rollback on error
 *   - update mutation
 *   - first-load localStorage → hub migration + banner status flip
 *   - banner dismissal persistence
 *   - per-session migration flag prevents re-migration
 *   - cap enforcement returns false from add()
 *   - local-only reorder via move()
 *
 * Per-test session id: each test calls `makeSid()` to get a fresh
 * session-scoped localStorage namespace. The hook's offline-cache
 * useEffect mirrors entries to `hapi.scratchlist.v1.${sessionId}` and
 * the cleanup effect can flush AFTER `afterEach` clears localStorage
 * for the next test, leaking entries that re-trigger the migration
 * path. Unique session ids sidestep the race.
 */

type HubEntry = { entryId: string; text: string; createdAt: number; updatedAt: number }

function createWrapper() {
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: { retry: false, gcTime: Infinity },
            mutations: { retry: false }
        }
    })
    return function Wrapper({ children }: { children: ReactNode }) {
        return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    }
}

function createMockApi(overrides: Partial<{
    getScratchlist: (sessionId: string) => Promise<{ entries: HubEntry[] }>
    createScratchlistEntry: (sessionId: string, body: { text: string; entryId?: string; createdAt?: number }) => Promise<{ entry: HubEntry }>
    updateScratchlistEntry: (sessionId: string, entryId: string, text: string) => Promise<{ entry: HubEntry }>
    deleteScratchlistEntry: (sessionId: string, entryId: string) => Promise<void>
}> = {}): ApiClient {
    return {
        getScratchlist: overrides.getScratchlist ?? (async () => ({ entries: [] })),
        createScratchlistEntry: overrides.createScratchlistEntry
            ?? (async (_sessionId, body) => ({
                entry: {
                    entryId: body.entryId ?? `auto-${Math.random()}`,
                    text: body.text,
                    createdAt: body.createdAt ?? Date.now(),
                    updatedAt: Date.now()
                }
            })),
        updateScratchlistEntry: overrides.updateScratchlistEntry
            ?? (async (_sessionId, entryId, text) => ({
                entry: { entryId, text, createdAt: 1000, updatedAt: 5000 }
            })),
        deleteScratchlistEntry: overrides.deleteScratchlistEntry ?? (async () => undefined)
    } as unknown as ApiClient
}

let nextSessionIdCounter = 0
function makeSid(): string {
    nextSessionIdCounter += 1
    return `s-${nextSessionIdCounter}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

beforeEach(() => {
    localStorage.clear()
})

afterEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
})

describe('useHubScratchlist - initial fetch', () => {
    it('exposes entries returned by the hub', async () => {
        const sid = makeSid()
        const api = createMockApi({
            getScratchlist: async () => ({
                entries: [
                    { entryId: 'a', text: 'first', createdAt: 1000, updatedAt: 1000 },
                    { entryId: 'b', text: 'second', createdAt: 2000, updatedAt: 2000 }
                ]
            })
        })
        const { result } = renderHook(() => useHubScratchlist(sid, api), { wrapper: createWrapper() })
        await waitFor(() => expect(result.current.entries.length).toBe(2))
        expect(result.current.entries.map((e) => e.id)).toEqual(['a', 'b'])
    })
})

describe('useHubScratchlist - add', () => {
    it('optimistically inserts the new entry then reconciles with the hub-returned row', async () => {
        const sid = makeSid()
        const api = createMockApi({
            getScratchlist: async () => ({ entries: [] }),
            createScratchlistEntry: async (_s, body) => ({
                entry: { entryId: 'hub-id', text: body.text, createdAt: 5000, updatedAt: 5000 }
            })
        })
        const { result } = renderHook(() => useHubScratchlist(sid, api), { wrapper: createWrapper() })
        await waitFor(() => expect(result.current.isLoading).toBe(false))

        let added: boolean | undefined
        await act(async () => {
            added = await result.current.add('new note')
        })
        expect(added).toBe(true)
        await waitFor(() => expect(result.current.entries.length).toBe(1))
        expect(result.current.entries[0]?.id).toBe('hub-id')
        expect(result.current.entries[0]?.text).toBe('new note')
    })

    it('dedupes when SSE refetch lands before POST resolves (HAPI Bot, PR #896)', async () => {
        const queryClient = new QueryClient({
            defaultOptions: {
                queries: { retry: false, gcTime: Infinity },
                mutations: { retry: false }
            }
        })
        const sid = makeSid()
        const canonical: HubEntry = { entryId: 'hub-id', text: 'new note', createdAt: 5000, updatedAt: 5000 }
        let releaseCreate: (value: { entry: HubEntry }) => void = () => undefined
        const createDeferred = new Promise<{ entry: HubEntry }>((resolve) => {
            releaseCreate = resolve
        })
        const api = createMockApi({
            getScratchlist: async () => ({ entries: [] }),
            createScratchlistEntry: async () => createDeferred
        })
        const wrapper = ({ children }: { children: ReactNode }) => (
            <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        )
        const { result } = renderHook(() => useHubScratchlist(sid, api), { wrapper })
        await waitFor(() => expect(result.current.isLoading).toBe(false))

        let addPromise: Promise<boolean> | undefined
        await act(async () => {
            addPromise = result.current.add('new note')
        })
        await waitFor(() => expect(result.current.entries.length).toBe(1))
        const optimisticId = result.current.entries[0]?.id
        expect(optimisticId).not.toBe('hub-id')

        // Simulate SSE invalidation/refetch beating the POST response.
        await act(async () => {
            queryClient.setQueryData(queryKeys.scratchlist(sid), {
                entries: [
                    canonical,
                    {
                        entryId: optimisticId!,
                        text: 'new note',
                        createdAt: 0,
                        updatedAt: 0
                    }
                ]
            })
        })

        await act(async () => {
            releaseCreate({ entry: canonical })
            await addPromise
        })

        await waitFor(() => {
            expect(result.current.entries.filter((e) => e.id === 'hub-id')).toHaveLength(1)
        })
        expect(result.current.entries).toHaveLength(1)
    })

    it('rolls back when the hub rejects the create', async () => {
        const sid = makeSid()
        const api = createMockApi({
            getScratchlist: async () => ({
                entries: [{ entryId: 'a', text: 'existing', createdAt: 1000, updatedAt: 1000 }]
            }),
            createScratchlistEntry: async () => {
                throw new Error('HTTP 500')
            }
        })
        const { result } = renderHook(() => useHubScratchlist(sid, api), { wrapper: createWrapper() })
        await waitFor(() => expect(result.current.entries.length).toBe(1))

        let added: boolean | undefined
        await act(async () => {
            added = await result.current.add('doomed')
        })
        expect(added).toBe(false)
        // After rollback, the original list is intact (no optimistic ghost).
        expect(result.current.entries.map((e) => e.id)).toEqual(['a'])
    })

    it('removes optimistic ghost when create fails before initial fetch populates (HAPI Bot, PR #896)', async () => {
        const sid = makeSid()
        let releaseFetch: (value: { entries: HubEntry[] }) => void = () => undefined
        const fetchDeferred = new Promise<{ entries: HubEntry[] }>((resolve) => {
            releaseFetch = resolve
        })
        const api = createMockApi({
            getScratchlist: async () => fetchDeferred,
            createScratchlistEntry: async () => {
                throw new Error('HTTP 409: scratchlist_at_cap')
            }
        })
        const { result } = renderHook(() => useHubScratchlist(sid, api), { wrapper: createWrapper() })
        // Do not wait for fetch - race create against empty previousData.
        let added: boolean | undefined
        await act(async () => {
            added = await result.current.add('ghost')
        })
        expect(added).toBe(false)
        await waitFor(() => expect(result.current.entries).toHaveLength(0))

        await act(async () => {
            releaseFetch({ entries: [] })
        })
        await waitFor(() => expect(result.current.isLoading).toBe(false))
        expect(result.current.entries).toHaveLength(0)
    })

    it('refuses to add empty text without calling the hub', async () => {
        const sid = makeSid()
        const create = vi.fn(async () => ({
            entry: { entryId: 'x', text: '', createdAt: 0, updatedAt: 0 }
        }))
        const api = createMockApi({
            getScratchlist: async () => ({ entries: [] }),
            createScratchlistEntry: create
        })
        const { result } = renderHook(() => useHubScratchlist(sid, api), { wrapper: createWrapper() })
        await waitFor(() => expect(result.current.isLoading).toBe(false))

        let added: boolean | undefined
        await act(async () => {
            added = await result.current.add('   ')
        })
        expect(added).toBe(false)
        expect(create).not.toHaveBeenCalled()
    })

    it('refuses to add when at the 200-entry cap', async () => {
        const sid = makeSid()
        const existing: HubEntry[] = Array.from({ length: 200 }, (_, i) => ({
            entryId: `id-${i}`,
            text: `note-${i}`,
            createdAt: i,
            updatedAt: i
        }))
        const create = vi.fn()
        const api = createMockApi({
            getScratchlist: async () => ({ entries: existing }),
            createScratchlistEntry: create as never
        })
        const { result } = renderHook(() => useHubScratchlist(sid, api), { wrapper: createWrapper() })
        await waitFor(() => expect(result.current.entries.length).toBe(200))

        let added: boolean | undefined
        await act(async () => {
            added = await result.current.add('overflow')
        })
        expect(added).toBe(false)
        expect(create).not.toHaveBeenCalled()
    })
})

describe('useHubScratchlist - delete', () => {
    it('optimistically removes the entry and survives a network error via rollback', async () => {
        const sid = makeSid()
        const api = createMockApi({
            getScratchlist: async () => ({
                entries: [
                    { entryId: 'a', text: 'A', createdAt: 1, updatedAt: 1 },
                    { entryId: 'b', text: 'B', createdAt: 2, updatedAt: 2 }
                ]
            }),
            deleteScratchlistEntry: async () => {
                throw new Error('HTTP 500')
            }
        })
        const { result } = renderHook(() => useHubScratchlist(sid, api), { wrapper: createWrapper() })
        await waitFor(() => expect(result.current.entries.length).toBe(2))

        await act(async () => {
            await result.current.remove('a')
        })
        // After rollback the entry is restored.
        await waitFor(() => expect(result.current.entries.length).toBe(2))
        expect(result.current.entries.map((e) => e.id).sort()).toEqual(['a', 'b'])
    })

    it('keeps entry removed when hub returns 404 (deleted elsewhere) (HAPI Bot, PR #896)', async () => {
        const queryClient = new QueryClient({
            defaultOptions: {
                queries: { retry: false, gcTime: Infinity },
                mutations: { retry: false }
            }
        })
        const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
        const sid = makeSid()
        let fetchCount = 0
        const api = createMockApi({
            getScratchlist: async () => {
                fetchCount += 1
                if (fetchCount === 1) {
                    return {
                        entries: [
                            { entryId: 'a', text: 'A', createdAt: 1, updatedAt: 1 },
                            { entryId: 'b', text: 'B', createdAt: 2, updatedAt: 2 }
                        ]
                    }
                }
                return {
                    entries: [{ entryId: 'b', text: 'B', createdAt: 2, updatedAt: 2 }]
                }
            },
            deleteScratchlistEntry: async () => {
                throw new ApiError('Not found', 404)
            }
        })
        const wrapper = ({ children }: { children: ReactNode }) => (
            <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        )
        const { result } = renderHook(() => useHubScratchlist(sid, api), { wrapper })
        await waitFor(() => expect(result.current.entries.length).toBe(2))

        await act(async () => {
            await result.current.remove('a')
        })
        await waitFor(() => expect(result.current.entries.map((e) => e.id)).toEqual(['b']))
        expect(invalidateSpy).toHaveBeenCalled()
    })
})

describe('useHubScratchlist - update', () => {
    it('optimistically updates text and reconciles with the hub-returned row', async () => {
        const sid = makeSid()
        const api = createMockApi({
            getScratchlist: async () => ({
                entries: [{ entryId: 'a', text: 'before', createdAt: 1, updatedAt: 1 }]
            }),
            updateScratchlistEntry: async (_s, entryId, text) => ({
                entry: { entryId, text, createdAt: 1, updatedAt: 5 }
            })
        })
        const { result } = renderHook(() => useHubScratchlist(sid, api), { wrapper: createWrapper() })
        await waitFor(() => expect(result.current.entries.length).toBe(1))

        await act(async () => {
            await result.current.update('a', 'after')
        })
        await waitFor(() => expect(result.current.entries[0]?.text).toBe('after'))
    })

    it('drops entry when update returns 404 (deleted elsewhere) (HAPI Bot, PR #896)', async () => {
        const sid = makeSid()
        let fetchCount = 0
        const api = createMockApi({
            getScratchlist: async () => {
                fetchCount += 1
                if (fetchCount === 1) {
                    return {
                        entries: [{ entryId: 'a', text: 'before', createdAt: 1, updatedAt: 1 }]
                    }
                }
                return { entries: [] }
            },
            updateScratchlistEntry: async () => {
                throw new ApiError('Not found', 404)
            }
        })
        const { result } = renderHook(() => useHubScratchlist(sid, api), { wrapper: createWrapper() })
        await waitFor(() => expect(result.current.entries.length).toBe(1))

        await act(async () => {
            await result.current.update('a', 'after')
        })
        await waitFor(() => expect(result.current.entries).toHaveLength(0))
    })
})

describe('useHubScratchlist - localStorage migration', () => {
    function seedV1Entries(sid: string) {
        localStorage.setItem(
            `hapi.scratchlist.v1.${sid}`,
            JSON.stringify([
                { id: 'old-1', text: 'pre-v2 note', createdAt: 100 },
                { id: 'old-2', text: 'another', createdAt: 200 }
            ])
        )
    }

    it('uploads localStorage entries when the hub returns empty and flips status to completed', async () => {
        const sid = makeSid()
        seedV1Entries(sid)
        const create = vi.fn(async (_s: string, body: { text: string; entryId?: string; createdAt?: number }) => ({
            entry: {
                entryId: body.entryId ?? 'fresh',
                text: body.text,
                createdAt: body.createdAt ?? 999,
                updatedAt: 999
            }
        }))
        let fetchCount = 0
        const api = createMockApi({
            getScratchlist: async () => {
                fetchCount += 1
                if (fetchCount === 1) {
                    return { entries: [] }
                }
                return {
                    entries: [
                        { entryId: 'old-1', text: 'pre-v2 note', createdAt: 100, updatedAt: 100 },
                        { entryId: 'old-2', text: 'another', createdAt: 200, updatedAt: 200 }
                    ]
                }
            },
            createScratchlistEntry: create
        })
        const { result } = renderHook(() => useHubScratchlist(sid, api), { wrapper: createWrapper() })

        await waitFor(() => expect(result.current.migrationStatus).toBe('completed'))
        expect(create).toHaveBeenCalledTimes(2)
        const entryIds = create.mock.calls.map((c) => (c[1] as { entryId?: string }).entryId)
        expect(entryIds.sort()).toEqual(['old-1', 'old-2'])
        expect(localStorage.getItem(`hapi.scratchlist.v2.migrated.${sid}`)).toBe('1')
    })

    it('does not re-migrate on a mount where the migrated flag is already set', async () => {
        const sid = makeSid()
        seedV1Entries(sid)
        localStorage.setItem(`hapi.scratchlist.v2.migrated.${sid}`, '1')
        const create = vi.fn()
        const api = createMockApi({
            getScratchlist: async () => ({ entries: [] }),
            createScratchlistEntry: create as never
        })
        const { result } = renderHook(() => useHubScratchlist(sid, api), { wrapper: createWrapper() })
        await waitFor(() => expect(result.current.isLoading).toBe(false))
        await new Promise((r) => setTimeout(r, 30))
        expect(create).not.toHaveBeenCalled()
        // HAPI Bot, PR #896 follow-up: migrationFlag-set without a
        // dismiss flag now means 'completed' (banner shows on
        // remount) so the operator gets a chance to see and dismiss
        // the banner across page reloads.
        expect(result.current.migrationStatus).toBe('completed')
    })

    it('reload-before-dismiss leaves the banner visible (PR #896 follow-up)', async () => {
        // Mount #1: real v1 entries exist, migration runs, status flips
        // to 'completed', banner is shown but the operator reloads
        // before clicking dismiss.
        const sid = makeSid()
        seedV1Entries(sid)
        const api = createMockApi({
            getScratchlist: async () => ({ entries: [] }),
            createScratchlistEntry: async (_id: string, body: { entryId?: string; text: string; createdAt?: number }) => ({
                entry: {
                    entryId: body.entryId ?? 'srv-' + body.text,
                    text: body.text,
                    createdAt: body.createdAt ?? Date.now(),
                    updatedAt: Date.now()
                }
            })
        })
        const first = renderHook(() => useHubScratchlist(sid, api), { wrapper: createWrapper() })
        await waitFor(() => expect(first.result.current.migrationStatus).toBe('completed'))
        first.unmount()

        // Mount #2: simulating a page reload with the migration flag
        // set but the dismiss flag still absent. Pre-fix the hook
        // mapped this to 'pre-migrated' and the banner stayed hidden
        // forever; post-fix the hook maps it to 'completed' so the
        // banner renders again until the operator clicks dismiss.
        expect(localStorage.getItem(`hapi.scratchlist.v2.migrated.${sid}`)).toBe('1')
        expect(localStorage.getItem(`hapi.scratchlist.v2.banner-dismissed.${sid}`)).toBeNull()
        const second = renderHook(() => useHubScratchlist(sid, api), { wrapper: createWrapper() })
        await waitFor(() => expect(second.result.current.isLoading).toBe(false))
        expect(second.result.current.migrationStatus).toBe('completed')
    })

    it('opts fresh sessions (no v1 entries) out of the banner pre-emptively', async () => {
        // Companion to the above: a session that NEVER had v1
        // entries should write BOTH the migrated and dismissed flags
        // up front so the banner never appears (now or on reload).
        // Without this opt-out the PR #896 fix would otherwise spam
        // every brand-new v2 session with a banner that has nothing
        // to announce.
        const sid = makeSid()
        // No seedV1Entries - localStorage is empty for this sid.
        const api = createMockApi({
            getScratchlist: async () => ({ entries: [] })
        })
        const { result } = renderHook(() => useHubScratchlist(sid, api), { wrapper: createWrapper() })
        await waitFor(() => expect(result.current.migrationStatus).toBe('dismissed'))
        expect(localStorage.getItem(`hapi.scratchlist.v2.migrated.${sid}`)).toBe('1')
        expect(localStorage.getItem(`hapi.scratchlist.v2.banner-dismissed.${sid}`)).toBe('1')
    })

    it('dismissMigrationBanner persists the dismissal flag and flips status to dismissed', async () => {
        const sid = makeSid()
        seedV1Entries(sid)
        const api = createMockApi({
            getScratchlist: async () => ({
                entries: [{ entryId: 'old-1', text: 'pre-v2 note', createdAt: 100, updatedAt: 100 }]
            }),
        })
        const { result } = renderHook(() => useHubScratchlist(sid, api), { wrapper: createWrapper() })
        await waitFor(() => expect(result.current.entries.length).toBe(1))

        // Dismissal is independent of how `completed` was reached - the
        // status flip is what matters for banner visibility (the banner
        // only renders for `completed`, so dismissing flips it off).
        act(() => {
            result.current.dismissMigrationBanner()
        })
        expect(result.current.migrationStatus).toBe('dismissed')
        expect(localStorage.getItem(`hapi.scratchlist.v2.banner-dismissed.${sid}`)).toBe('1')
    })

    it('skips migration when localStorage is empty and pre-dismisses the banner (HAPI Bot, PR #896 follow-up)', async () => {
        const sid = makeSid()
        const create = vi.fn()
        const api = createMockApi({
            getScratchlist: async () => ({ entries: [] }),
            createScratchlistEntry: create as never
        })
        const { result } = renderHook(() => useHubScratchlist(sid, api), { wrapper: createWrapper() })
        await waitFor(() => expect(result.current.isLoading).toBe(false))
        await waitFor(() => expect(localStorage.getItem(`hapi.scratchlist.v2.migrated.${sid}`)).toBe('1'))
        expect(create).not.toHaveBeenCalled()
        // Fresh sessions (no v1 entries) get the banner pre-dismissed
        // so the bot's banner-stickiness fix does not surface a
        // banner that has nothing to announce.
        expect(localStorage.getItem(`hapi.scratchlist.v2.banner-dismissed.${sid}`)).toBe('1')
        expect(result.current.migrationStatus).toBe('dismissed')
    })

    it('persists FAILED entries back to localStorage and leaves the flag unset (HAPI Bot, PR #896)', async () => {
        // Migration partial failure: 2 entries in localStorage, the
        // first POST succeeds and the second throws. Per the bot
        // review, the failed entry must be written back to
        // localStorage and the migration flag must NOT advance, so a
        // future mount can retry. The status drops back to 'idle'
        // (banner does not render).
        const sid = makeSid()
        seedV1Entries(sid)
        let postCall = 0
        const create = vi.fn(async (_s: string, body: { text: string; entryId?: string; createdAt?: number }) => {
            postCall += 1
            if (postCall === 1) {
                return {
                    entry: {
                        entryId: body.entryId ?? 'a',
                        text: body.text,
                        createdAt: body.createdAt ?? 0,
                        updatedAt: 0
                    }
                }
            }
            throw new Error('HTTP 500: hub flaked on entry 2')
        })
        const api = createMockApi({
            getScratchlist: async () => ({ entries: [] }),
            createScratchlistEntry: create
        })
        const { result } = renderHook(() => useHubScratchlist(sid, api), { wrapper: createWrapper() })
        await waitFor(() => expect(create).toHaveBeenCalledTimes(2))
        await waitFor(() => expect(result.current.migrationStatus).toBe('idle'))

        // Flag must NOT be set: a future mount must retry.
        expect(localStorage.getItem(`hapi.scratchlist.v2.migrated.${sid}`)).toBeNull()
        // The failed entry (the second one) must be back in localStorage.
        const persisted = localStorage.getItem(`hapi.scratchlist.v1.${sid}`)
        expect(persisted).not.toBeNull()
        const parsed = JSON.parse(persisted!) as Array<{ id: string; text: string }>
        expect(parsed.map((e) => e.id)).toEqual(['old-2'])
        expect(parsed[0]?.text).toBe('another')
    })

    it('does not retry failed migration in a tight loop within the same mount (HAPI Bot, PR #896)', async () => {
        const sid = makeSid()
        seedV1Entries(sid)
        const create = vi.fn(async () => {
            throw new Error('HTTP 409: scratchlist_at_cap')
        })
        const api = createMockApi({
            getScratchlist: async () => ({ entries: [] }),
            createScratchlistEntry: create
        })
        const { result } = renderHook(() => useHubScratchlist(sid, api), { wrapper: createWrapper() })
        await waitFor(() => expect(create).toHaveBeenCalledTimes(2))
        await waitFor(() => expect(result.current.migrationStatus).toBe('idle'))
        const callsAfterFailure = create.mock.calls.length

        // Let any spurious effect churn settle - must not hammer the hub.
        await act(async () => {
            await new Promise((r) => setTimeout(r, 100))
        })
        expect(create).toHaveBeenCalledTimes(callsAfterFailure)
    })

    it('does NOT mirror an empty hub fetch into localStorage before migration runs (HAPI Bot, PR #896)', async () => {
        // Pre-fix the offline-cache effect would clobber the v1
        // entries with `[]` the moment the initial fetch returned an
        // empty list, racing the migration effect's localStorage
        // read on a future mount. The fix gates the cache mirror on
        // the migration flag; this test pins it.
        const sid = makeSid()
        seedV1Entries(sid)
        const apiCalls: number[] = []
        const api = createMockApi({
            // Block on first fetch so we can inspect localStorage
            // BEFORE the migration effect kicks off.
            getScratchlist: async () => {
                apiCalls.push(Date.now())
                if (apiCalls.length === 1) {
                    await new Promise((r) => setTimeout(r, 25))
                    return { entries: [] }
                }
                return {
                    entries: [
                        { entryId: 'old-1', text: 'pre-v2 note', createdAt: 100, updatedAt: 100 },
                        { entryId: 'old-2', text: 'another', createdAt: 200, updatedAt: 200 }
                    ]
                }
            }
        })
        const { result } = renderHook(() => useHubScratchlist(sid, api), { wrapper: createWrapper() })
        // Wait for migration to complete (flag set + status flips).
        await waitFor(() => expect(result.current.migrationStatus).toBe('completed'), { timeout: 2000 })
        // localStorage now mirrors hub state (post-migration). It must
        // contain the v1 entries that round-tripped through the hub
        // fetch, NOT an empty array.
        const persisted = localStorage.getItem(`hapi.scratchlist.v1.${sid}`)
        expect(persisted).not.toBeNull()
        const parsed = JSON.parse(persisted!) as Array<{ id: string }>
        expect(parsed.map((e) => e.id).sort()).toEqual(['old-1', 'old-2'])
    })
})

describe('useHubScratchlist - reorder (local-only)', () => {
    it('move() reorders entries in-place without calling the hub', async () => {
        const sid = makeSid()
        const updateMock = vi.fn()
        const api = createMockApi({
            getScratchlist: async () => ({
                entries: [
                    { entryId: 'top', text: 'top', createdAt: 100, updatedAt: 100 },
                    { entryId: 'bot', text: 'bot', createdAt: 50, updatedAt: 50 }
                ]
            }),
            updateScratchlistEntry: updateMock as never
        })
        const { result } = renderHook(() => useHubScratchlist(sid, api), { wrapper: createWrapper() })
        await waitFor(() => expect(result.current.entries.length).toBe(2))
        expect(result.current.entries.map((e) => e.id)).toEqual(['top', 'bot'])

        await act(async () => {
            result.current.move('bot', 'up')
        })
        await waitFor(() => {
            expect(result.current.entries.map((e) => e.id)).toEqual(['bot', 'top'])
        })
        expect(updateMock).not.toHaveBeenCalled()
    })
})
