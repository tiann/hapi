import { createHighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import type { HighlighterCore } from 'shiki/core'
import type { Root, RootContent } from 'hast'
import { useState, useEffect, useMemo, type ReactNode } from 'react'
import { toJsxRuntime } from 'hast-util-to-jsx-runtime'
import { jsx, jsxs, Fragment } from 'react/jsx-runtime'

// Only 2 themes
const THEMES = [
    import('@shikijs/themes/github-light'),
    import('@shikijs/themes/github-dark'),
]

// 30 common languages for LLM code output
const LANGS = [
    // Shell
    import('@shikijs/langs/shellscript'),
    import('@shikijs/langs/powershell'),
    // Data formats
    import('@shikijs/langs/json'),
    import('@shikijs/langs/yaml'),
    import('@shikijs/langs/toml'),
    import('@shikijs/langs/xml'),
    import('@shikijs/langs/ini'),
    // Markup
    import('@shikijs/langs/markdown'),
    import('@shikijs/langs/html'),
    import('@shikijs/langs/css'),
    import('@shikijs/langs/scss'),
    // JavaScript ecosystem
    import('@shikijs/langs/javascript'),
    import('@shikijs/langs/typescript'),
    import('@shikijs/langs/jsx'),
    import('@shikijs/langs/tsx'),
    // Query languages
    import('@shikijs/langs/sql'),
    import('@shikijs/langs/graphql'),
    // Systems languages
    import('@shikijs/langs/c'),
    import('@shikijs/langs/rust'),
    import('@shikijs/langs/go'),
    // JVM
    import('@shikijs/langs/java'),
    import('@shikijs/langs/kotlin'),
    // Scripting
    import('@shikijs/langs/python'),
    import('@shikijs/langs/php'),
    // Apple
    import('@shikijs/langs/swift'),
    // .NET
    import('@shikijs/langs/csharp'),
    // DevOps
    import('@shikijs/langs/dockerfile'),
    import('@shikijs/langs/make'),
    // Misc
    import('@shikijs/langs/diff'),
]

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

// Singleton highlighter instance
let highlighterPromise: Promise<HighlighterCore> | null = null

function getHighlighter(): Promise<HighlighterCore> {
    if (!highlighterPromise) {
        highlighterPromise = createHighlighterCore({
            themes: THEMES,
            langs: LANGS,
            engine: createJavaScriptRegexEngine({ forgiving: true }),
        })
    }
    return highlighterPromise
}

function resolveLanguage(lang: string | undefined): string {
    if (!lang) return 'text'
    const cleaned = lang.startsWith('language-') ? lang.slice('language-'.length) : lang
    const lower = cleaned.toLowerCase().trim()
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

/**
 * Custom hook for syntax highlighting with our minimal Shiki bundle.
 * Returns a single ReactNode of the highlighted code (inline structure),
 * or null while pending / for unsupported languages (plain-text fallback).
 */
export function useShikiHighlighter(
    code: string,
    language: string | undefined
): ReactNode | null {
    const [highlighted, setHighlighted] = useState<ReactNode | null>(null)
    const lang = useMemo(() => resolveLanguage(language), [language])

    useEffect(() => {
        let cancelled = false

        async function highlight() {
            const highlighter = await getHighlighter()
            if (cancelled) return

            const loadedLangs = highlighter.getLoadedLanguages()

            // Skip highlighting for unsupported languages (graceful fallback to plain text)
            if (lang === 'text' || !loadedLangs.includes(lang)) {
                setHighlighted(null)
                return
            }

            const hast = highlighter.codeToHast(code, {
                lang,
                themes: SHIKI_THEMES,
                defaultColor: false,
                structure: 'inline',
            })

            if (cancelled) return

            const rendered = toJsxRuntime(hast, {
                jsx,
                jsxs,
                Fragment,
            })
            setHighlighted(rendered as ReactNode)
        }

        // Debounce highlighting — 150ms reduces CPU pressure on Windows during
        // streaming where code blocks update rapidly (see #310)
        const timer = setTimeout(highlight, 150)
        return () => {
            cancelled = true
            clearTimeout(timer)
        }
    }, [code, lang])

    return highlighted
}

/**
 * Like {@link useShikiHighlighter} but returns the highlighted code split
 * into one ReactNode per logical line, so callers can render each line in
 * its own row with an aligned line number that survives wrapping. Returns
 * null while pending / for unsupported languages (the caller falls back to
 * splitting the raw `code` on newlines).
 */
export function useShikiHighlightedLines(
    code: string,
    language: string | undefined
): ReactNode[] | null {
    const [lines, setLines] = useState<ReactNode[] | null>(null)
    const lang = useMemo(() => resolveLanguage(language), [language])

    useEffect(() => {
        let cancelled = false

        async function highlight() {
            const highlighter = await getHighlighter()
            if (cancelled) return

            const loadedLangs = highlighter.getLoadedLanguages()

            // Skip highlighting for unsupported languages (graceful fallback to plain text)
            if (lang === 'text' || !loadedLangs.includes(lang)) {
                setLines(null)
                return
            }

            const lineNodes = highlightToLineNodes(highlighter, code, lang)

            if (cancelled) return

            setLines(lineNodes)
        }

        // Debounce highlighting — 150ms reduces CPU pressure on Windows during
        // streaming where code blocks update rapidly (see #310)
        const timer = setTimeout(highlight, 150)
        return () => {
            cancelled = true
            clearTimeout(timer)
        }
    }, [code, lang])

    return lines
}
