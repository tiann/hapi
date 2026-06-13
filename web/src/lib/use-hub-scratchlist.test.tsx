import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { ApiClient } from '@/api/client'
import { useHubScratchlist } from './use-hub-scratchlist'

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
        expect(['pre-migrated', 'idle']).toContain(result.current.migrationStatus)
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

    it('skips migration when localStorage is empty but still sets the flag (so future loads do not probe again)', async () => {
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
        expect(result.current.migrationStatus).toBe('idle')
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
