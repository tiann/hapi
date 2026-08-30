import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { useOpencodeReasoningEffortOptions } from './useOpencodeReasoningEffortOptions'

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('useOpencodeReasoningEffortOptions pending-switch polling', () => {
    it('keeps polling while the backend reports the previous model, and continues after a model change', async () => {
        const queryClient = new QueryClient()
        const getSessionOpencodeReasoningEffortOptions = vi.fn(async () => ({
            success: true,
            options: [{ value: 'low', name: 'Low' }],
            currentValue: 'low',
            // Backend still reports the previous model → mismatch polling.
            currentModelId: 'opencode/big-pickle'
        }))
        const api = { getSessionOpencodeReasoningEffortOptions } as never

        const wrapper = ({ children }: { children: React.ReactNode }) =>
            createElement(QueryClientProvider, { client: queryClient }, children)

        const { result, rerender } = renderHook(
            ({ model }) => useOpencodeReasoningEffortOptions({
                api,
                sessionId: 'session-1',
                enabled: true,
                sessionModel: model
            }),
            { wrapper, initialProps: { model: 'opencode/hy3-free' } }
        )

        await waitFor(() => expect(getSessionOpencodeReasoningEffortOptions).toHaveBeenCalledTimes(1))
        expect(result.current.options).toEqual([])
        expect(result.current.currentValue).toBeNull()
        await sleep(2300)
        // Mismatch polling: at least two intervals' worth of refetches.
        expect(getSessionOpencodeReasoningEffortOptions.mock.calls.length).toBeGreaterThanOrEqual(2)

        const callsBeforeSwitch = getSessionOpencodeReasoningEffortOptions.mock.calls.length
        rerender({ model: 'opencode-go/ox-alpha-free' })
        await sleep(2300)
        // Budget reset on model change: polling continues on the new model.
        expect(getSessionOpencodeReasoningEffortOptions.mock.calls.length).toBeGreaterThan(callsBeforeSwitch)
    })

    it('hides cached options immediately when the session model changes', async () => {
        const queryClient = new QueryClient()
        let resolveRefetch: (() => void) | undefined
        const refetchPending = new Promise<void>((resolve) => {
            resolveRefetch = resolve
        })
        const getSessionOpencodeReasoningEffortOptions = vi.fn()
            .mockResolvedValueOnce({
                success: true,
                options: [{ value: 'high', name: 'High' }],
                currentValue: 'high',
                currentModelId: 'provider/model-a',
                targetModelId: 'provider/model-a'
            })
            .mockImplementationOnce(async () => {
                await refetchPending
                return {
                    success: true,
                    options: [{ value: 'low', name: 'Low' }],
                    currentValue: 'low',
                    currentModelId: 'provider/model-b',
                    targetModelId: 'provider/model-b'
                }
            })
        const api = { getSessionOpencodeReasoningEffortOptions } as never
        const wrapper = ({ children }: { children: React.ReactNode }) =>
            createElement(QueryClientProvider, { client: queryClient }, children)

        const { result, rerender } = renderHook(
            ({ model }) => useOpencodeReasoningEffortOptions({
                api,
                sessionId: 'session-1',
                enabled: true,
                sessionModel: model
            }),
            { wrapper, initialProps: { model: 'provider/model-a' } }
        )

        await waitFor(() => expect(result.current.options).toEqual([{ value: 'high', name: 'High' }]))
        rerender({ model: 'provider/model-b' })

        expect(result.current.options).toEqual([])
        expect(result.current.currentValue).toBeNull()
        resolveRefetch?.()
    })
})
