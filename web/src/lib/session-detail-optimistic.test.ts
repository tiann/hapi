import { describe, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/lib/query-client'
import { queryKeys } from '@/lib/query-keys'
import {
    mergeSessionDetailIfActiveUnchanged,
    refreshSessionDetailPreservingActive,
} from './session-detail-optimistic'

describe('mergeSessionDetailIfActiveUnchanged', () => {
    it('keeps a newer inactive SSE transition over a late active response', () => {
        const current = {
            session: { id: 'session-reopened', active: false, title: 'sse-inactive' },
        }
        const response = {
            session: { id: 'session-reopened', active: true, title: 'stale-active' },
        }
        expect(mergeSessionDetailIfActiveUnchanged(current, response)).toBe(current)
    })

    it('applies the response when active still matches', () => {
        const current = {
            session: { id: 'session-reopened', active: true, title: 'seeded' },
        }
        const response = {
            session: { id: 'session-reopened', active: true, title: 'fresh' },
        }
        expect(mergeSessionDetailIfActiveUnchanged(current, response)).toEqual(response)
    })
})

describe('refreshSessionDetailPreservingActive', () => {
    it('does not resurrect active after the cache went inactive mid-flight', async () => {
        const queryClient = createQueryClient()
        const resolvedSessionId = 'session-reopened'
        queryClient.setQueryData(queryKeys.session(resolvedSessionId), {
            session: { id: resolvedSessionId, active: true, title: 'seeded' },
        })

        let release!: () => void
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        const fetchDetail = vi.fn(async () => {
            await gate
            return {
                session: { id: resolvedSessionId, active: true, title: 'late' },
            }
        })

        const refresh = refreshSessionDetailPreservingActive(
            queryClient,
            resolvedSessionId,
            fetchDetail,
        )
        queryClient.setQueryData(queryKeys.session(resolvedSessionId), {
            session: { id: resolvedSessionId, active: false, title: 'sse-inactive' },
        })
        release()
        await refresh

        expect(queryClient.getQueryData(queryKeys.session(resolvedSessionId))).toEqual({
            session: { id: resolvedSessionId, active: false, title: 'sse-inactive' },
        })
    })
})
