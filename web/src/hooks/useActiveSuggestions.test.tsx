import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { type Suggestion, useActiveSuggestions } from './useActiveSuggestions'

function suggestion(key: string): Suggestion {
    return {
        key,
        text: key,
        label: key,
    }
}

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise
    })
    return { promise, resolve }
}

describe('useActiveSuggestions', () => {
    it('publishes only the latest query result when an older request resolves first', async () => {
        const first = deferred<Suggestion[]>()
        const second = deferred<Suggestion[]>()
        const handler = vi.fn((query: string) => query === '@a' ? first.promise : second.promise)
        const { result, rerender } = renderHook(
            ({ query }) => useActiveSuggestions(query, handler),
            { initialProps: { query: '@a' } }
        )

        await waitFor(() => expect(handler).toHaveBeenCalledWith('@a'))

        rerender({ query: '@ab' })
        await act(async () => {
            first.resolve([suggestion('stale')])
            await first.promise
        })

        await waitFor(() => expect(handler).toHaveBeenCalledWith('@ab'))
        expect(result.current[0]).toEqual([])
        expect(result.current[1]).toBe(-1)

        await act(async () => {
            second.resolve([suggestion('current')])
            await second.promise
        })

        await waitFor(() => expect(result.current[0].map((item) => item.key)).toEqual(['current']))
        expect(result.current[1]).toBe(0)
    })

    it('uses a committed replacement handler and discards the old handler result', async () => {
        const oldRequest = deferred<Suggestion[]>()
        const newRequest = deferred<Suggestion[]>()
        const oldHandler = vi.fn(() => oldRequest.promise)
        const replacementHandler = vi.fn(() => newRequest.promise)
        const { result, rerender } = renderHook(
            ({ handler }) => useActiveSuggestions('@query', handler),
            { initialProps: { handler: oldHandler } }
        )

        await waitFor(() => expect(oldHandler).toHaveBeenCalledWith('@query'))

        rerender({ handler: replacementHandler })
        await act(async () => {
            oldRequest.resolve([suggestion('old-handler')])
            await oldRequest.promise
        })

        await waitFor(() => expect(replacementHandler).toHaveBeenCalledWith('@query'))
        expect(oldHandler).toHaveBeenCalledTimes(1)
        expect(result.current[0]).toEqual([])
        expect(result.current[1]).toBe(-1)

        await act(async () => {
            newRequest.resolve([suggestion('replacement-handler')])
            await newRequest.promise
        })

        await waitFor(() => expect(result.current[0].map((item) => item.key)).toEqual(['replacement-handler']))
        expect(result.current[1]).toBe(0)
    })

    it('preserves the selected suggestion by key when a refreshed list is reordered', async () => {
        const initialHandler = vi.fn(async () => [suggestion('one'), suggestion('two'), suggestion('three')])
        const reorderedHandler = vi.fn(async () => [suggestion('two'), suggestion('three'), suggestion('one')])
        const { result, rerender } = renderHook(
            ({ handler }) => useActiveSuggestions('@query', handler),
            { initialProps: { handler: initialHandler } }
        )

        await waitFor(() => expect(result.current[0].map((item) => item.key)).toEqual(['one', 'two', 'three']))
        expect(result.current[1]).toBe(0)

        act(() => result.current[3]())
        expect(result.current[1]).toBe(1)

        rerender({ handler: reorderedHandler })

        await waitFor(() => expect(result.current[0].map((item) => item.key)).toEqual(['two', 'three', 'one']))
        expect(result.current[1]).toBe(0)
    })

    it('clamps when the selected key disappears and clears the selection for empty results', async () => {
        const initialHandler = vi.fn(async () => [suggestion('one'), suggestion('two'), suggestion('three')])
        const filteredHandler = vi.fn(async () => [suggestion('one')])
        const emptyHandler = vi.fn(async () => [])
        const { result, rerender } = renderHook(
            ({ handler }) => useActiveSuggestions('@query', handler),
            { initialProps: { handler: initialHandler } }
        )

        await waitFor(() => expect(result.current[0]).toHaveLength(3))
        act(() => {
            result.current[3]()
            result.current[3]()
        })
        expect(result.current[1]).toBe(2)

        rerender({ handler: filteredHandler })
        await waitFor(() => expect(result.current[0].map((item) => item.key)).toEqual(['one']))
        expect(result.current[1]).toBe(0)

        rerender({ handler: emptyHandler })
        await waitFor(() => expect(result.current[0]).toEqual([]))
        expect(result.current[1]).toBe(-1)
    })

    it('leaves the first item unselected when autoSelectFirst is disabled', async () => {
        const handler = vi.fn(async () => [suggestion('one')])
        const { result } = renderHook(
            () => useActiveSuggestions('@query', handler, { autoSelectFirst: false })
        )

        await waitFor(() => expect(result.current[0]).toHaveLength(1))
        expect(result.current[1]).toBe(-1)
    })

    it('wraps selection at list boundaries when wrapAround is enabled', async () => {
        const handler = vi.fn(async () => [suggestion('one'), suggestion('two')])
        const { result } = renderHook(
            () => useActiveSuggestions('@query', handler, { wrapAround: true })
        )

        await waitFor(() => expect(result.current[0]).toHaveLength(2))
        expect(result.current[1]).toBe(0)

        act(() => result.current[2]())
        expect(result.current[1]).toBe(1)

        act(() => result.current[3]())
        expect(result.current[1]).toBe(0)
    })

    it('clamps selection at list boundaries when wrapAround is disabled', async () => {
        const handler = vi.fn(async () => [suggestion('one'), suggestion('two')])
        const { result } = renderHook(
            () => useActiveSuggestions('@query', handler, { wrapAround: false })
        )

        await waitFor(() => expect(result.current[0]).toHaveLength(2))
        expect(result.current[1]).toBe(0)

        act(() => result.current[2]())
        expect(result.current[1]).toBe(0)

        act(() => {
            result.current[3]()
            result.current[3]()
        })
        expect(result.current[1]).toBe(1)
    })
})
