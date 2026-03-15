import { createHighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import type { HighlighterCore } from 'shiki/core'
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
 * Custom hook for syntax highlighting with our minimal Shiki bundle
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

        // Debounce highlighting
        const timer = setTimeout(highlight, 50)
        return () => {
            cancelled = true
            clearTimeout(timer)
        }
    }, [code, lang])

    return highlighted
}
