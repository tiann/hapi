import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Metadata } from '@hapi/protocol/types'
import type { ApiClient } from '@/api/client'
import { useRewindPending } from './useRewindPending'

afterEach(cleanup)

function metadata(phase: NonNullable<Metadata['claudeRewind']>['phase'], operationId = 'op-1'): Metadata {
    return { path: '/tmp', host: 'host', claudeRewind: {
        operationId, phase, requestedLocalId: 'local-1', cutoffSeq: 1,
    } }
}

describe('durable rewind pending', () => {
    it.each([true, false])('runs destructive completion effects only for completed responses (pending=%s)', async (pending) => {
        const { result } = renderHook(() => useRewindPending(null))
        const response = {
            session: { metadata: metadata('pending') }, ...(pending ? { pending: true } : {}),
        } as Awaited<ReturnType<ApiClient['rewindConversation']>>
        const removeSuffix = vi.fn()
        const refresh = vi.fn(async () => {})
        const scroll = vi.fn()
        await act(async () => {
            await result.current.runRewind(async () => response, async () => {
                removeSuffix()
                await refresh()
                scroll()
            })
        })
        expect(result.current.pending).toBe(pending)
        expect(removeSuffix).toHaveBeenCalledTimes(pending ? 0 : 1)
        expect(refresh).toHaveBeenCalledTimes(pending ? 0 : 1)
        expect(scroll).toHaveBeenCalledTimes(pending ? 0 : 1)
    })

    it.each(['requested', 'pending', 'applied', 'unknown'] as const)('locks history on restored %s metadata', (phase) => {
        const { result } = renderHook(() => useRewindPending(metadata(phase)))
        expect(result.current.pending).toBe(true)
    })

    it.each(['committed', 'rejected'] as const)('unlocks only after matching %s metadata', (phase) => {
        const { result, rerender } = renderHook(({ value }) => useRewindPending(value), {
            initialProps: { value: metadata('committed', 'previous-op') },
        })
        act(() => result.current.acceptPending('op-1'))
        expect(result.current.pending).toBe(true)
        rerender({ value: metadata('pending') })
        rerender({ value: metadata('applied') })
        expect(result.current.pending).toBe(true)
        rerender({ value: metadata(phase) })
        expect(result.current.pending).toBe(false)
        rerender({ value: metadata('pending', 'op-2') })
        expect(result.current.pending).toBe(true)
        rerender({ value: metadata('committed', 'op-2') })
        expect(result.current.pending).toBe(false)
    })

    it('bridges the HTTP 202 acknowledgement before metadata arrives', () => {
        const { result, rerender } = renderHook(({ value }: { value: Metadata | null }) => useRewindPending(value), {
            initialProps: { value: null as Metadata | null },
        })
        expect(result.current.pending).toBe(false)
        act(() => result.current.acceptPending())
        expect(result.current.pending).toBe(true)
        rerender({ value: metadata('unknown') })
        expect(result.current.pending).toBe(true)
        rerender({ value: metadata('committed') })
        expect(result.current.pending).toBe(false)
    })
})
