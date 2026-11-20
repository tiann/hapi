import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, type ApiClient } from '@/api/client'
import { useVisibilityReporter } from '@/hooks/useVisibilityReporter'

function setVisibilityState(state: DocumentVisibilityState): void {
    Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: state,
    })
}

function deferred<T>(): {
    promise: Promise<T>
    resolve: (value: T) => void
} {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((promiseResolve) => {
        resolve = promiseResolve
    })
    return { promise, resolve }
}

afterEach(() => {
    setVisibilityState('visible')
})

describe('useVisibilityReporter', () => {
    it('preserves a hidden transition that arrives while a visible report is pending', async () => {
        const visibleReport = deferred<void>()
        const api = {
            setVisibility: vi.fn()
                .mockImplementationOnce(() => visibleReport.promise)
                .mockResolvedValue(undefined),
        } as unknown as ApiClient

        setVisibilityState('visible')
        renderHook(() => useVisibilityReporter({ api, subscriptionId: 'sub-1' }))

        expect(api.setVisibility).toHaveBeenCalledWith({
            subscriptionId: 'sub-1',
            visibility: 'visible',
        })

        setVisibilityState('hidden')
        act(() => {
            document.dispatchEvent(new Event('visibilitychange'))
        })

        expect(api.setVisibility).toHaveBeenCalledTimes(1)

        await act(async () => {
            visibleReport.resolve(undefined)
        })

        expect(api.setVisibility).toHaveBeenNthCalledWith(2, {
            subscriptionId: 'sub-1',
            visibility: 'hidden',
        })
    })

    it('preserves a visible transition that arrives while a hidden report is pending', async () => {
        const hiddenReport = deferred<void>()
        const api = {
            setVisibility: vi.fn()
                .mockImplementationOnce(() => hiddenReport.promise)
                .mockResolvedValue(undefined),
        } as unknown as ApiClient

        setVisibilityState('hidden')
        renderHook(() => useVisibilityReporter({ api, subscriptionId: 'sub-1' }))

        expect(api.setVisibility).toHaveBeenCalledWith({
            subscriptionId: 'sub-1',
            visibility: 'hidden',
        })

        setVisibilityState('visible')
        act(() => {
            document.dispatchEvent(new Event('visibilitychange'))
        })

        expect(api.setVisibility).toHaveBeenCalledTimes(1)

        await act(async () => {
            hiddenReport.resolve(undefined)
        })

        expect(api.setVisibility).toHaveBeenNthCalledWith(2, {
            subscriptionId: 'sub-1',
            visibility: 'visible',
        })
    })

    it('does not let a previous subscription unlock a new report', async () => {
        const oldReport = deferred<void>()
        const newReport = deferred<void>()
        const api = {
            setVisibility: vi.fn()
                .mockImplementationOnce(() => oldReport.promise)
                .mockImplementationOnce(() => newReport.promise)
                .mockResolvedValue(undefined),
        } as unknown as ApiClient

        setVisibilityState('visible')
        const { rerender } = renderHook(
            ({ subscriptionId }) => useVisibilityReporter({ api, subscriptionId }),
            { initialProps: { subscriptionId: 'sub-old' } },
        )

        rerender({ subscriptionId: 'sub-new' })
        expect(api.setVisibility).toHaveBeenCalledTimes(2)

        await act(async () => {
            oldReport.resolve(undefined)
        })

        setVisibilityState('hidden')
        act(() => {
            document.dispatchEvent(new Event('visibilitychange'))
        })
        expect(api.setVisibility).toHaveBeenCalledTimes(2)

        await act(async () => {
            newReport.resolve(undefined)
        })

        expect(api.setVisibility).toHaveBeenNthCalledWith(3, {
            subscriptionId: 'sub-new',
            visibility: 'hidden',
        })
    })

    it('stops reporting for a subscription after a 404 rejection', async () => {
        vi.useFakeTimers()
        try {
            const api = {
                setVisibility: vi.fn().mockRejectedValue(new ApiError('HTTP 404 Not Found', 404)),
            } as unknown as ApiClient

            setVisibilityState('visible')
            renderHook(() => useVisibilityReporter({ api, subscriptionId: 'sub-gone' }))

            await act(async () => {
                await vi.advanceTimersByTimeAsync(0)
            })
            expect(api.setVisibility).toHaveBeenCalledTimes(1)

            // No retry for a permanent rejection, and later visibility changes
            // stay silent for this subscription id.
            await act(async () => {
                await vi.advanceTimersByTimeAsync(60_000)
            })
            expect(api.setVisibility).toHaveBeenCalledTimes(1)

            setVisibilityState('hidden')
            act(() => {
                document.dispatchEvent(new Event('visibilitychange'))
            })
            await act(async () => {
                await vi.advanceTimersByTimeAsync(60_000)
            })
            expect(api.setVisibility).toHaveBeenCalledTimes(1)
        } finally {
            vi.useRealTimers()
        }
    })

    it('resumes reporting once a new subscription id replaces a rejected one', async () => {
        vi.useFakeTimers()
        try {
            const api = {
                setVisibility: vi.fn()
                    .mockRejectedValueOnce(new ApiError('HTTP 404 Not Found', 404))
                    .mockResolvedValue(undefined),
            } as unknown as ApiClient

            setVisibilityState('visible')
            const { rerender } = renderHook(
                ({ subscriptionId }) => useVisibilityReporter({ api, subscriptionId }),
                { initialProps: { subscriptionId: 'sub-old' } },
            )

            await act(async () => {
                await vi.advanceTimersByTimeAsync(0)
            })
            expect(api.setVisibility).toHaveBeenCalledTimes(1)

            rerender({ subscriptionId: 'sub-new' })
            await act(async () => {
                await vi.advanceTimersByTimeAsync(0)
            })

            expect(api.setVisibility).toHaveBeenCalledTimes(2)
            expect(api.setVisibility).toHaveBeenNthCalledWith(2, {
                subscriptionId: 'sub-new',
                visibility: 'visible',
            })
        } finally {
            vi.useRealTimers()
        }
    })

    it('retries transient failures with exponential backoff', async () => {
        vi.useFakeTimers()
        try {
            const api = {
                setVisibility: vi.fn()
                    .mockRejectedValueOnce(new Error('network down'))
                    .mockRejectedValueOnce(new ApiError('HTTP 502 Bad Gateway', 502))
                    .mockResolvedValue(undefined),
            } as unknown as ApiClient

            setVisibilityState('visible')
            renderHook(() => useVisibilityReporter({ api, subscriptionId: 'sub-1' }))

            expect(api.setVisibility).toHaveBeenCalledTimes(1)

            // First retry after 2s.
            await act(async () => {
                await vi.advanceTimersByTimeAsync(2_000)
            })
            expect(api.setVisibility).toHaveBeenCalledTimes(2)

            // Second retry after 4s more; nothing in between.
            await act(async () => {
                await vi.advanceTimersByTimeAsync(2_000)
            })
            expect(api.setVisibility).toHaveBeenCalledTimes(2)
            await act(async () => {
                await vi.advanceTimersByTimeAsync(2_000)
            })
            expect(api.setVisibility).toHaveBeenCalledTimes(3)

            // Third attempt succeeds; no further calls.
            await act(async () => {
                await vi.advanceTimersByTimeAsync(10_000)
            })
            expect(api.setVisibility).toHaveBeenCalledTimes(3)
        } finally {
            vi.useRealTimers()
        }
    })

    it('stops retrying a transient failure after the attempt budget is exhausted', async () => {
        vi.useFakeTimers()
        try {
            const api = {
                setVisibility: vi.fn().mockRejectedValue(new Error('network down')),
            } as unknown as ApiClient

            setVisibilityState('visible')
            renderHook(() => useVisibilityReporter({ api, subscriptionId: 'sub-1' }))

            // 1 initial attempt + 5 retries = 6 calls; delays 2s, 4s, 8s, 16s, 32s.
            await act(async () => {
                await vi.advanceTimersByTimeAsync(2_000 + 4_000 + 8_000 + 16_000 + 32_000 + 1_000)
            })
            expect(api.setVisibility).toHaveBeenCalledTimes(6)

            // Budget exhausted: no further retries for this report.
            await act(async () => {
                await vi.advanceTimersByTimeAsync(120_000)
            })
            expect(api.setVisibility).toHaveBeenCalledTimes(6)

            // A new visibility transition starts a fresh budget.
            setVisibilityState('hidden')
            act(() => {
                document.dispatchEvent(new Event('visibilitychange'))
            })
            expect(api.setVisibility).toHaveBeenCalledTimes(7)
            expect(api.setVisibility).toHaveBeenNthCalledWith(7, {
                subscriptionId: 'sub-1',
                visibility: 'hidden',
            })
        } finally {
            vi.useRealTimers()
        }
    })
})
