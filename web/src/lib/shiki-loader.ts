import { createHighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import type { HighlighterCore } from 'shiki/core'

// Functions, not started imports: plain messages and unsupported fences fetch no grammars.
const languages = {
    shellscript: () => import('@shikijs/langs/shellscript'),
    powershell: () => import('@shikijs/langs/powershell'),
    json: () => import('@shikijs/langs/json'),
    yaml: () => import('@shikijs/langs/yaml'),
    toml: () => import('@shikijs/langs/toml'),
    xml: () => import('@shikijs/langs/xml'),
    ini: () => import('@shikijs/langs/ini'),
    markdown: () => import('@shikijs/langs/markdown'),
    html: () => import('@shikijs/langs/html'),
    css: () => import('@shikijs/langs/css'),
    scss: () => import('@shikijs/langs/scss'),
    javascript: () => import('@shikijs/langs/javascript'),
    typescript: () => import('@shikijs/langs/typescript'),
    jsx: () => import('@shikijs/langs/jsx'),
    tsx: () => import('@shikijs/langs/tsx'),
    sql: () => import('@shikijs/langs/sql'),
    graphql: () => import('@shikijs/langs/graphql'),
    c: () => import('@shikijs/langs/c'),
    rust: () => import('@shikijs/langs/rust'),
    go: () => import('@shikijs/langs/go'),
    java: () => import('@shikijs/langs/java'),
    kotlin: () => import('@shikijs/langs/kotlin'),
    python: () => import('@shikijs/langs/python'),
    php: () => import('@shikijs/langs/php'),
    swift: () => import('@shikijs/langs/swift'),
    csharp: () => import('@shikijs/langs/csharp'),
    docker: () => import('@shikijs/langs/dockerfile'),
    make: () => import('@shikijs/langs/make'),
    diff: () => import('@shikijs/langs/diff'),
}

let highlighterPromise: Promise<HighlighterCore> | null = null
const pendingLanguages = new Map<string, Promise<void>>()

function getCore(): Promise<HighlighterCore> {
    if (!highlighterPromise) {
        highlighterPromise = createHighlighterCore({
            themes: [import('@shikijs/themes/github-light'), import('@shikijs/themes/github-dark')],
            langs: [],
            engine: createJavaScriptRegexEngine({ forgiving: true }),
        }).catch((error) => {
            highlighterPromise = null
            throw error
        })
    }
    return highlighterPromise
}

async function loadLanguage(highlighter: HighlighterCore, language: keyof typeof languages): Promise<void> {
    if (highlighter.getLoadedLanguages().includes(language)) return
    let pending = pendingLanguages.get(language)
    if (!pending) {
        pending = highlighter.loadLanguage(languages[language]())
        pendingLanguages.set(language, pending)
    }
    try {
        await pending
    } finally {
        if (pendingLanguages.get(language) === pending) pendingLanguages.delete(language)
    }
}

export async function getLanguageHighlighter(language: string): Promise<HighlighterCore | null> {
    if (!Object.hasOwn(languages, language)) return null
    const highlighter = await getCore()
    // Markdown grammars can embed any of the previously supported languages.
    // Keep those colors identical; only an actual Markdown fence pays this cost.
    const required = language === 'markdown' ? Object.keys(languages) : [language]
    await Promise.all(required.map((name) => loadLanguage(highlighter, name as keyof typeof languages)))
    return highlighter
}
