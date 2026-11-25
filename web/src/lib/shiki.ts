import { getLanguageHighlighter } from './shiki-loader'
import type { HighlighterCore } from 'shiki/core'
import type { Root, RootContent } from 'hast'
import { useState, useEffect, useMemo, type ReactNode } from 'react'
import { toJsxRuntime } from 'hast-util-to-jsx-runtime'
import { jsx, jsxs, Fragment } from 'react/jsx-runtime'

export const SHIKI_THEMES = {
    light: 'github-light',
    dark: 'github-dark',
} as const

// Alias common code fence language names to canonical names
export const langAlias: Record<string, string> = {
    sh: 'shellscript',
    bash: 'shellscript',
    zsh: 'shellscript',
    shell: 'shellscript',
    ps1: 'powershell',
    ps: 'powershell',
    properties: 'ini',
    kts: 'kotlin',
    'c#': 'csharp',
    dockerfile: 'docker',
    js: 'javascript',
    ts: 'typescript',
    mjs: 'javascript',
    cjs: 'javascript',
    mts: 'typescript',
    cts: 'typescript',
    yml: 'yaml',
    md: 'markdown',
    htm: 'html',
    pgsql: 'sql',
    mysql: 'sql',
    postgres: 'sql',
    gql: 'graphql',
    py: 'python',
    rs: 'rust',
    kt: 'kotlin',
    cs: 'csharp',
    makefile: 'make',
}

function resolveLanguage(lang: string | undefined): string {
    if (!lang) return 'text'
    const cleaned = lang.toLowerCase().trim()
    const lower = cleaned.startsWith('language-') ? cleaned.slice('language-'.length) : cleaned
    if (lower === 'text' || lower === 'plaintext' || lower === 'txt') return 'text'
    return langAlias[lower] ?? lower
}

/**
 * Normalize code the way the line renderer counts lines: a single trailing
 * newline is dropped so `"a\n"` is one line, not one line plus an empty
 * one. Shared by the highlighted and plain-text-fallback paths so both
 * produce the same number of lines.
 */
function stripTrailingNewline(code: string): string {
    return code.endsWith('\n') ? code.slice(0, -1) : code
}

/**
 * Split raw code into logical lines for the plain-text fallback (when
 * highlighting is unavailable). Mirrors the normalization applied before
 * highlighting so line numbers line up on both paths.
 */
export function splitCodeLines(code: string): string[] {
    return stripTrailingNewline(code).split('\n')
}

/**
 * Split an inline shiki hast tree into per-logical-line child arrays.
 *
 * With `structure: 'inline'`, shiki emits a flat list of token `<span>`s
 * with `<br>` elements marking line breaks (verified against the bundled
 * shiki version). Grouping on those `<br>` boundaries yields one child
 * array per source line, so each line can be rendered in its own grid row
 * with an aligned line number — even when the line wraps.
 *
 * The number of returned groups always equals `splitCodeLines(code).length`:
 * N lines have N-1 `<br>`s between them, so N-1 splits produce N groups
 * (including interior empty lines).
 */
export function splitHastLines(hast: Root): RootContent[][] {
    const lines: RootContent[][] = []
    let current: RootContent[] = []
    for (const child of hast.children) {
        if (child.type === 'element' && child.tagName === 'br') {
            lines.push(current)
            current = []
        } else {
            current.push(child)
        }
    }
    lines.push(current)
    return lines
}

function highlightToLineNodes(highlighter: HighlighterCore, code: string, lang: string): ReactNode[] {
    const hast = highlighter.codeToHast(stripTrailingNewline(code), {
        lang,
        themes: SHIKI_THEMES,
        defaultColor: false,
        structure: 'inline',
    })

    return splitHastLines(hast as Root).map((children) => {
        const lineRoot: Root = { type: 'root', children }
        return toJsxRuntime(lineRoot, { jsx, jsxs, Fragment }) as ReactNode
    })
}

function highlightToNode(highlighter: HighlighterCore, code: string, lang: string): ReactNode {
    const hast = highlighter.codeToHast(code, {
        lang,
        themes: SHIKI_THEMES,
        defaultColor: false,
        structure: 'inline',
    })
    return toJsxRuntime(hast, { jsx, jsxs, Fragment })
}

function useHighlightedCode<T>(
    code: string,
    language: string | undefined,
    render: (highlighter: HighlighterCore, code: string, lang: string) => T,
): T | null {
    const lang = useMemo(() => resolveLanguage(language), [language])
    const [result, setResult] = useState<{ code: string; lang: string; value: T } | null>(null)

    useEffect(() => {
        let cancelled = false
        async function highlight() {
            try {
                const highlighter = await getLanguageHighlighter(lang)
                if (cancelled || !highlighter) return
                const value = render(highlighter, code, lang)
                if (!cancelled) setResult({ code, lang, value })
            } catch {
                // Offline/chunk/tokenization failures retain readable plain text.
                if (!cancelled) setResult(null)
            }
        }
        // Preserve the streaming debounce; do not display tokens for an older input.
        const timer = setTimeout(highlight, 150)
        return () => {
            cancelled = true
            clearTimeout(timer)
        }
    }, [code, lang, render])

    return result?.code === code && result.lang === lang ? result.value : null
}

/** Highlight supported fences on demand; null means use the plain-text fallback. */
export function useShikiHighlighter(code: string, language: string | undefined): ReactNode | null {
    return useHighlightedCode(code, language, highlightToNode)
}

/** Highlight one ReactNode per logical line, preserving line numbers and wrapping. */
export function useShikiHighlightedLines(code: string, language: string | undefined): ReactNode[] | null {
    return useHighlightedCode(code, language, highlightToLineNodes)
}
