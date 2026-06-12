import { describe, expect, it } from 'vitest'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { hasActiveSessionDetailObserver, isGlobalScopedMessageStreamEvent } from './useSSE'
import { queryKeys } from '@/lib/query-keys'

describe('useSSE scope handling', () => {
    it('treats message stream events as global-scoped skips', () => {
        expect(isGlobalScopedMessageStreamEvent('global', 'message-received')).toBe(true)
        expect(isGlobalScopedMessageStreamEvent('global', 'messages-consumed')).toBe(true)
        expect(isGlobalScopedMessageStreamEvent('global', 'message-cancelled')).toBe(true)
        expect(isGlobalScopedMessageStreamEvent('global', 'scheduled-matured')).toBe(true)
    })

    it('does not skip session lifecycle events on the global connection', () => {
        expect(isGlobalScopedMessageStreamEvent('global', 'session-updated')).toBe(false)
        expect(isGlobalScopedMessageStreamEvent('global', 'session-added')).toBe(false)
        expect(isGlobalScopedMessageStreamEvent('global', 'session-removed')).toBe(false)
    })

    it('processes message stream events on full-scoped connections', () => {
        expect(isGlobalScopedMessageStreamEvent('full', 'message-received')).toBe(false)
    })
})

describe('hasActiveSessionDetailObserver', () => {
    function makeClient(): QueryClient {
        return new QueryClient({
            defaultOptions: { queries: { retry: false } },
        })
    }

    it('returns false when no cache entry exists for the session', () => {
        const client = makeClient()
        expect(hasActiveSessionDetailObserver(client, 'session-1')).toBe(false)
    })

    it('returns false when a cache entry exists but no observer is mounted', () => {
        const client = makeClient()
        client.setQueryData(queryKeys.session('session-1'), { session: { id: 'session-1' } })
        expect(hasActiveSessionDetailObserver(client, 'session-1')).toBe(false)
    })

    it('returns true while a query observer is subscribed to the session detail', () => {
        const client = makeClient()
        const observer = new QueryObserver(client, {
            queryKey: queryKeys.session('session-1'),
            queryFn: async () => ({ session: { id: 'session-1' } }),
            enabled: true,
            staleTime: Infinity,
        })
        const unsubscribe = observer.subscribe(() => {})
        try {
            expect(hasActiveSessionDetailObserver(client, 'session-1')).toBe(true)
        } finally {
            unsubscribe()
        }
        // After unsubscribe, the cache entry remains but the observer count drops to zero.
        expect(hasActiveSessionDetailObserver(client, 'session-1')).toBe(false)
    })

    it('only returns true for the specific session being observed', () => {
        const client = makeClient()
        const observer = new QueryObserver(client, {
            queryKey: queryKeys.session('session-A'),
            queryFn: async () => ({ session: { id: 'session-A' } }),
            enabled: true,
            staleTime: Infinity,
        })
        const unsubscribe = observer.subscribe(() => {})
        try {
            expect(hasActiveSessionDetailObserver(client, 'session-A')).toBe(true)
            expect(hasActiveSessionDetailObserver(client, 'session-B')).toBe(false)
        } finally {
            unsubscribe()
        }
    })
})
