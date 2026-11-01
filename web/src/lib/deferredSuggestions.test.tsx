import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useActiveSuggestions, type Suggestion, type SuggestionHandler } from '@/hooks/useActiveSuggestions'
import { createDeferredSuggestions } from './deferredSuggestions'

const item = (key: string): Suggestion => ({ key, text: key, label: key })
function deferred() {
    let resolve!: (value: Suggestion[]) => void
    let reject!: (reason: Error) => void
    const promise = new Promise<Suggestion[]>((yes, no) => { resolve = yes; reject = no })
    return { promise, resolve, reject }
}

describe('deferred file suggestions', () => {
    it.each([false, true])('keeps the selected file during a same-query refresh (offline=%s)', async (offline) => {
        const cache = createDeferredSuggestions()
        const first = deferred()
        const refresh = deferred()
        const handler: SuggestionHandler = (query, context) => Promise.resolve(
            cache(query, [item('session')], () => first.promise, context)
        )
        const replacement: SuggestionHandler = (query, context) => Promise.resolve(
            cache(query, [item('new-session'), item('session')], () => refresh.promise, context)
        )
        const { result, rerender } = renderHook(({ handler }) => useActiveSuggestions('@file', handler), {
            initialProps: { handler }
        })
        await waitFor(() => expect(result.current[0]).toEqual([item('session')]))
        await act(async () => { first.resolve([item('file')]); await first.promise })
        act(() => result.current[3]())
        expect(result.current[0][result.current[1]].key).toBe('file')
        rerender({ handler: replacement })
        await waitFor(() => expect(result.current[0]).toHaveLength(3))
        expect(result.current[0][result.current[1]].key).toBe('file')
        await act(async () => {
            if (offline) refresh.reject(new Error('runner offline'))
            else refresh.resolve([item('other-file'), item('file')])
            await refresh.promise.catch(() => {})
        })
        expect(result.current[0][result.current[1]].key).toBe('file')
    })

    it('does not reuse files for a different query or session', async () => {
        const cache = createDeferredSuggestions()
        const handler: SuggestionHandler = (query, context) => Promise.resolve(
            cache(query, [], async () => [item('file')], context)
        )
        const { result, rerender } = renderHook(({ query }) => useActiveSuggestions(query, handler), {
            initialProps: { query: 'session-a:@one' }
        })
        await waitFor(() => expect(result.current[0]).toEqual([item('file')]))
        const pending = deferred()
        const request = { signal: new AbortController().signal, publish: () => {} }
        expect(cache('session-a:@two', [], () => pending.promise, request)).toEqual([])
        expect(cache('session-b:@one', [], () => pending.promise, request)).toEqual([])
        rerender({ query: 'session-b:@one' })
        await waitFor(() => expect(result.current[0]).toEqual([item('file')]))
    })

    it('does not let an aborted response poison the cached results', async () => {
        const cache = createDeferredSuggestions()
        const old = deferred()
        const controller = new AbortController()
        cache('same', [], () => old.promise, { signal: controller.signal, publish: () => {} })
        await Promise.resolve()
        controller.abort()
        old.resolve([item('stale')])
        await old.promise
        const pending = deferred()
        expect(cache('same', [], () => pending.promise, {
            signal: new AbortController().signal, publish: () => {}
        })).toEqual([])
    })
})
