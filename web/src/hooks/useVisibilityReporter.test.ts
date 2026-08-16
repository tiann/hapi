import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
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
})
