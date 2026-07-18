import { describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useActiveSuggestions, type Suggestion } from './useActiveSuggestions'

function makeSuggestion(label: string): Suggestion {
    return {
        key: label,
        text: label,
        label,
    }
}

describe('useActiveSuggestions', () => {
    it('does not re-run the active query just because the handler identity changed', async () => {
        const initialHandler = vi.fn(async () => [makeSuggestion('$playwright')])

        const { result, rerender } = renderHook(
            ({ query, handler }: { query: string | null; handler: (query: string) => Promise<Suggestion[]> }) =>
                useActiveSuggestions(query, handler),
            {
                initialProps: {
                    query: '$',
                    handler: initialHandler,
                },
            }
        )

        await waitFor(() => {
            expect(initialHandler).toHaveBeenCalledTimes(1)
            expect(result.current[0].map((item) => item.label)).toEqual(['$playwright'])
        })

        const replacementHandler = vi.fn(async () => [makeSuggestion('$superpowers:using-superpowers')])
        rerender({ query: '$', handler: replacementHandler })

        await new Promise((resolve) => setTimeout(resolve, 50))

        expect(replacementHandler).not.toHaveBeenCalled()
        expect(result.current[0].map((item) => item.label)).toEqual(['$playwright'])
    })

    it('reruns the active query when the explicit refresh key changes', async () => {
        const initialHandler = vi.fn(async () => [makeSuggestion('@cached')])

        const { result, rerender } = renderHook(
            ({ query, handler, refreshKey }: { query: string | null; handler: (query: string) => Promise<Suggestion[]>; refreshKey: number }) =>
                useActiveSuggestions(query, handler, { refreshKey }),
            {
                initialProps: {
                    query: '@',
                    handler: initialHandler,
                    refreshKey: 1,
                },
            }
        )

        await waitFor(() => {
            expect(result.current[0].map((item) => item.label)).toEqual(['@cached'])
        })

        const replacementHandler = vi.fn(async () => [makeSuggestion('@fresh')])
        rerender({ query: '@', handler: replacementHandler, refreshKey: 2 })

        await waitFor(() => {
            expect(replacementHandler).toHaveBeenCalledTimes(1)
            expect(result.current[0].map((item) => item.label)).toEqual(['@fresh'])
        })
    })

})
