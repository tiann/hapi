import { describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import {
    getSessionReasoningEffortRefetchInterval,
    selectSessionReasoningEffortResponse,
    shouldRetrySessionReasoningEffortQuery,
    useSessionReasoningEffortOptions
} from './useSessionReasoningEffortOptions'

describe('useSessionReasoningEffortOptions retry policy', () => {
    it.each([false, true])('hides cached A options until A to B to A is revalidated, requestFails=%s', async (requestFails) => {
        const queryClient = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } })
        const responseA = { success: true, model: 'A', options: [{ value: 'high', name: 'High' }], currentValue: 'high' }
        const responseB = { success: true, model: 'B', options: [{ value: 'low', name: 'Low' }], currentValue: 'low' }
        let resolveDiscovery!: (response: typeof responseB) => void
        let rejectDiscovery!: (error: Error) => void
        const getSessionReasoningEffortOptions = vi.fn()
            .mockResolvedValueOnce(responseA)
            .mockResolvedValueOnce(responseB)
            .mockImplementationOnce(() => new Promise((resolve, reject) => { resolveDiscovery = resolve; rejectDiscovery = reject }))
            .mockRejectedValue(new Error('offline'))
        const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: queryClient }, children)
        const { result, rerender, unmount } = renderHook(({ model }) => useSessionReasoningEffortOptions({
            api: { getSessionReasoningEffortOptions } as never, sessionId: 'session', model, enabled: true
        }), { wrapper, initialProps: { model: 'A' } })
        try {
            await waitFor(() => expect(result.current.options).toEqual(responseA.options))
            rerender({ model: 'B' })
            await waitFor(() => expect(result.current.options).toEqual(responseB.options))
            rerender({ model: 'A' })
            expect(result.current.options).toEqual([])
            expect(result.current.currentValue).toBeNull()
            await waitFor(() => expect(getSessionReasoningEffortOptions).toHaveBeenCalledTimes(3))
            await act(async () => requestFails ? rejectDiscovery(new Error('offline')) : resolveDiscovery(responseB))
            await waitFor(() => expect(result.current.error).toBe(requestFails ? 'offline' : 'Session model is still switching'))
            expect(result.current.options).toEqual([])
        } finally {
            unmount()
            queryClient.clear()
        }
    })
    it('retries transient failures up to three times', () => {
        expect(shouldRetrySessionReasoningEffortQuery(0)).toBe(true)
        expect(shouldRetrySessionReasoningEffortQuery(2)).toBe(true)
        expect(shouldRetrySessionReasoningEffortQuery(3)).toBe(false)
    })

    it('polls until the ACP handler returns effort options', () => {
        expect(getSessionReasoningEffortRefetchInterval(true, undefined, 0)).toBe(1000)
        expect(getSessionReasoningEffortRefetchInterval(true, { success: false, error: 'not ready' }, 2)).toBe(4000)
        expect(getSessionReasoningEffortRefetchInterval(true, {
            success: true,
            options: [{ value: 'low', name: 'Low' }]
        }, 1)).toBe(false)
    })

    it('keeps polling until the ACP handler returns a successful response', () => {
        expect(getSessionReasoningEffortRefetchInterval(false, undefined, 0)).toBe(false)
        expect(getSessionReasoningEffortRefetchInterval(true, undefined, 10)).toBe(8000)
        expect(getSessionReasoningEffortRefetchInterval(true, {
            success: false,
            error: 'not ready'
        }, 20)).toBe(8000)
        expect(getSessionReasoningEffortRefetchInterval(true, {
            success: true,
            model: 'gpt-5.6',
            options: []
        }, 20)).toBe(false)
    })

    it('rejects effort options discovered for a different applied model', () => {
        const response = {
            success: true,
            model: 'gpt-5.4',
            options: [{ value: 'high', name: 'High' }]
        }

        expect(selectSessionReasoningEffortResponse(response, 'gpt-5.6')).toEqual({
            success: false,
            error: 'Session model is still switching'
        })
        expect(selectSessionReasoningEffortResponse(response, 'gpt-5.4')).toBe(response)
    })
})
