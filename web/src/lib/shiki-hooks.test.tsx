import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HighlighterCore } from 'shiki/core'
import { getLanguageHighlighter } from './shiki-loader'
import { useShikiHighlightedLines, useShikiHighlighter } from './shiki'

vi.mock('./shiki-loader', () => ({ getLanguageHighlighter: vi.fn() }))
const load = vi.mocked(getLanguageHighlighter)
const highlighter = {
    codeToHast: vi.fn((code: string) => ({ type: 'root', children: [{ type: 'text', value: code }] })),
} as unknown as HighlighterCore

beforeEach(() => {
    vi.useFakeTimers()
    load.mockReset().mockResolvedValue(highlighter)
})
afterEach(() => { cleanup(); vi.useRealTimers() })

describe.each([useShikiHighlighter, useShikiHighlightedLines])('highlight hook %s', (useHighlight) => {
    it('debounces streaming and immediately removes obsolete highlighted text', async () => {
        const { result, rerender } = renderHook(({ code, lang }) => useHighlight(code, lang), {
            initialProps: { code: 'old', lang: 'ts' },
        })
        await act(() => vi.advanceTimersByTimeAsync(150))
        expect(result.current).not.toBeNull()
        rerender({ code: 'new', lang: 'text' })
        expect(result.current).toBeNull()
        load.mockResolvedValue(null)
        await act(() => vi.advanceTimersByTimeAsync(150))
        expect(result.current).toBeNull()
        expect(load).toHaveBeenCalledWith('typescript')
    })

    it('falls back on import failure and can highlight a later update', async () => {
        load.mockRejectedValueOnce(new Error('offline'))
        const { result, rerender } = renderHook(({ code }) => useHighlight(code, 'language-ts'), {
            initialProps: { code: 'first' },
        })
        await act(() => vi.advanceTimersByTimeAsync(150))
        expect(result.current).toBeNull()
        rerender({ code: 'second' })
        await act(() => vi.advanceTimersByTimeAsync(150))
        expect(result.current).not.toBeNull()
    })

    it('ignores a late load after switching code/language', async () => {
        let finish!: (value: HighlighterCore) => void
        load.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
        const { result, rerender } = renderHook(({ lang }) => useHighlight('code', lang), {
            initialProps: { lang: 'py' },
        })
        await act(() => vi.advanceTimersByTimeAsync(150))
        rerender({ lang: 'unknown' })
        await act(async () => { finish(highlighter) })
        expect(result.current).toBeNull()
    })

    it.each([['PS', 'powershell'], ['kts', 'kotlin'], ['c#', 'csharp'],
        ['properties', 'ini'], ['dockerfile', 'docker'], [' language-TS ', 'typescript']])(
        'preserves the %s alias', async (input, canonical) => {
            renderHook(() => useHighlight('code', input))
            await act(() => vi.advanceTimersByTimeAsync(150))
            expect(load).toHaveBeenCalledWith(canonical)
        },
    )
})
