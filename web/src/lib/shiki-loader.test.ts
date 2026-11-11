import { describe, expect, it } from 'vitest'
import { getLanguageHighlighter } from './shiki-loader'

describe('on-demand grammars', () => {
    it('does not initialize for plain text, unknown names or object prototype keys', async () => {
        for (const name of ['text', 'unknown', 'constructor', '__proto__']) {
            expect(await getLanguageHighlighter(name)).toBeNull()
        }
    })

    it('loads only the requested language and shares concurrent initialization', async () => {
        const [first, second] = await Promise.all([
            getLanguageHighlighter('typescript'), getLanguageHighlighter('typescript'),
        ])
        expect(first).toBe(second)
        expect(first!.getLoadedLanguages()).toContain('typescript')
        for (const name of ['python', 'rust', 'java', 'markdown']) {
            expect(first!.getLoadedLanguages()).not.toContain(name)
        }
        expect(first!.codeToTokens('const answer: number = 42', {
            lang: 'typescript', theme: 'github-light',
        }).tokens[0].some((token) => token.color !== '#24292e')).toBe(true)
    })

    it('includes required HTML embeddings and preserves nested Markdown highlighting', async () => {
        const highlighter = (await getLanguageHighlighter('html'))!
        expect(highlighter.getLoadedLanguages()).toEqual(expect.arrayContaining(['html', 'javascript', 'css']))
        await getLanguageHighlighter('markdown')
        const { createHighlighterCore } = await import('shiki/core')
        const { createJavaScriptRegexEngine } = await import('shiki/engine/javascript')
        const names = ['shellscript', 'powershell', 'json', 'yaml', 'toml', 'xml', 'ini',
            'markdown', 'html', 'css', 'scss', 'javascript', 'typescript', 'jsx', 'tsx',
            'sql', 'graphql', 'c', 'rust', 'go', 'java', 'kotlin', 'python', 'php',
            'swift', 'csharp', 'dockerfile', 'make', 'diff']
        // Reference uses the original all-at-once grammar set and engine options.
        const reference = await createHighlighterCore({
            themes: [import('@shikijs/themes/github-light'), import('@shikijs/themes/github-dark')],
            langs: names.map((name) => import(/* @vite-ignore */ `@shikijs/langs/${name}`)),
            engine: createJavaScriptRegexEngine({ forgiving: true }),
        })
        try {
            const cases = [
                ['typescript', 'const answer: number = 42'],
                ['tsx', 'const view = <button onClick={() => true}>Hi</button>'],
                ['html', '<style>p { color: red }</style><script>const x = 1</script>'],
                ['php', '<?php echo "hello"; ?><script>const x = 1</script>'],
                ['markdown', '# Title\n```python\ndef greet():\n    return True\n```\n```ts\nconst x: number = 1\n```'],
                ['shellscript', '#!/bin/sh\necho "$HOME"'],
                ['docker', 'FROM alpine:latest\nRUN echo hello'],
                ['rust', 'fn main() { println!("hello"); }'],
            ]
            for (const [lang, code] of cases) {
                for (const theme of ['github-light', 'github-dark']) {
                    expect(highlighter.codeToTokens(code, { lang, theme })).toEqual(reference.codeToTokens(code, { lang, theme }))
                }
            }
            expect(highlighter.getLoadedLanguages().sort()).toEqual(reference.getLoadedLanguages().sort())
        } finally {
            reference.dispose()
        }
    })
})
