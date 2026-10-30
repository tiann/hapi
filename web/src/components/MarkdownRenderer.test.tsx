import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import { MarkdownRenderer } from './MarkdownRenderer'

describe('MarkdownRenderer', () => {
    afterEach(() => {
        cleanup()
    })

    it('renders fenced code blocks with the shared syntax highlighter shell in standalone mode', () => {
        render(
            <I18nProvider>
                <MarkdownRenderer standalone content={'```ts\nexport const ok = true\n```'} />
            </I18nProvider>
        )

        expect(document.querySelector('.aui-md-codeblock')).toBeTruthy()
    })

    it('renders inline code without the fenced-code shell in standalone mode', () => {
        render(
            <I18nProvider>
                <MarkdownRenderer standalone content={'Use `npm test` here.'} />
            </I18nProvider>
        )

        expect(document.querySelector('.aui-md-codeblock')).toBeFalsy()
        expect(document.querySelector('.aui-md-code')).toBeTruthy()
    })

    it.each(['markdown', 'md'])('keeps the gutter padding for %s fenced blocks', (language) => {
        const code = Array.from({ length: 123 }, (_, index) => `line ${index + 1}`).join('\n')
        render(
            <I18nProvider>
                <MarkdownRenderer standalone content={`\`\`\`${language}\n${code}\n\`\`\``} />
            </I18nProvider>
        )

        const grid = document.querySelector('[data-hapi-code-grid="true"]') as HTMLElement | null
        expect(grid?.style.gridTemplateColumns).toBe('calc(3ch + 1.5rem) max-content')
        expect(document.querySelectorAll('[data-line-number]')).toHaveLength(123)
    })

    it('renders TeX bracket math in standalone mode', () => {
        const { container } = render(
            <I18nProvider>
                <MarkdownRenderer standalone content={String.raw`\[
E = mc^2
\]`} />
            </I18nProvider>
        )

        expect(container.querySelector('.katex-display')).toBeTruthy()
        expect(container.querySelector('.katex')).toBeTruthy()
        expect(container.textContent).not.toContain('\\[')
    })

    it('renders TeX bracket math through the assistant-ui path', () => {
        const { container } = render(
            <I18nProvider>
                <MarkdownRenderer content={String.raw`Result: \(x^2\)`} />
            </I18nProvider>
        )

        expect(container.querySelector('.katex')).toBeTruthy()
        expect(container.querySelector('.katex-display')).toBeFalsy()
    })
})
