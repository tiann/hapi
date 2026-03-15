import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useShikiHighlighter, langAlias, SHIKI_THEMES } from './shiki'

// Mock shiki core
vi.mock('shiki/core', () => ({
    createHighlighterCore: vi.fn(async () => ({
        codeToHast: vi.fn((code: string) => ({
            type: 'element',
            tagName: 'pre',
            children: [
                {
                    type: 'element',
                    tagName: 'code',
                    children: [{ type: 'text', value: code }],
                },
            ],
        })),
        getLoadedLanguages: vi.fn(() => ['javascript', 'typescript', 'python', 'shellscript']),
    })),
}))

vi.mock('shiki/engine/javascript', () => ({
    createJavaScriptRegexEngine: vi.fn(() => ({})),
}))

describe('langAlias', () => {
    it('maps common shell aliases', () => {
        expect(langAlias.sh).toBe('shellscript')
        expect(langAlias.bash).toBe('shellscript')
        expect(langAlias.zsh).toBe('shellscript')
        expect(langAlias.shell).toBe('shellscript')
    })

    it('maps JavaScript aliases', () => {
        expect(langAlias.js).toBe('javascript')
        expect(langAlias.mjs).toBe('javascript')
        expect(langAlias.cjs).toBe('javascript')
    })

    it('maps TypeScript aliases', () => {
        expect(langAlias.ts).toBe('typescript')
        expect(langAlias.mts).toBe('typescript')
        expect(langAlias.cts).toBe('typescript')
    })

    it('maps data format aliases', () => {
        expect(langAlias.yml).toBe('yaml')
        expect(langAlias.md).toBe('markdown')
    })
})

describe('SHIKI_THEMES', () => {
    it('defines light and dark themes', () => {
        expect(SHIKI_THEMES.light).toBe('github-light')
        expect(SHIKI_THEMES.dark).toBe('github-dark')
    })
})

describe('useShikiHighlighter', () => {
    beforeEach(() => {
        vi.clearAllTimers()
    })

    it('returns null initially', () => {
        const { result } = renderHook(() => useShikiHighlighter('const x = 1', 'javascript'))
        expect(result.current).toBeNull()
    })

    it('highlights code after debounce', async () => {
        const { result } = renderHook(() => useShikiHighlighter('const x = 1', 'javascript'))

        expect(result.current).toBeNull()

        await waitFor(() => {
            expect(result.current).not.toBeNull()
        }, { timeout: 10000 })
    }, 15000)

    it('resolves language aliases', async () => {
        const { result } = renderHook(() => useShikiHighlighter('echo "hello"', 'sh'))

        await waitFor(() => {
            expect(result.current).not.toBeNull()
        }, { timeout: 10000 })
    }, 15000)

    it('handles language- prefix', async () => {
        const { result } = renderHook(() => useShikiHighlighter('print("hello")', 'language-python'))

        await waitFor(() => {
            expect(result.current).not.toBeNull()
        }, { timeout: 10000 })
    }, 15000)

    it('returns null for unsupported languages', async () => {
        const { result } = renderHook(() => useShikiHighlighter('code', 'unsupported-lang'))

        await waitFor(() => {
            expect(result.current).toBeNull()
        }, { timeout: 10000 })
    }, 15000)

    it('returns null for text/plaintext', async () => {
        const { result: result1 } = renderHook(() => useShikiHighlighter('plain text', 'text'))
        const { result: result2 } = renderHook(() => useShikiHighlighter('plain text', 'plaintext'))
        const { result: result3 } = renderHook(() => useShikiHighlighter('plain text', 'txt'))

        await waitFor(() => {
            expect(result1.current).toBeNull()
            expect(result2.current).toBeNull()
            expect(result3.current).toBeNull()
        }, { timeout: 10000 })
    }, 15000)

    it('handles undefined language', async () => {
        const { result } = renderHook(() => useShikiHighlighter('code', undefined))

        await waitFor(() => {
            expect(result.current).toBeNull()
        }, { timeout: 10000 })
    }, 15000)

    it('cancels previous highlight on code change', async () => {
        const { result, rerender } = renderHook(
            ({ code, lang }) => useShikiHighlighter(code, lang),
            {
                initialProps: { code: 'const x = 1', lang: 'javascript' },
            }
        )

        rerender({ code: 'const y = 2', lang: 'javascript' })

        await waitFor(() => {
            expect(result.current).not.toBeNull()
        }, { timeout: 10000 })
    }, 15000)

    it('cleans up on unmount', () => {
        const { unmount } = renderHook(() => useShikiHighlighter('code', 'javascript'))

        expect(() => unmount()).not.toThrow()
    })
})
