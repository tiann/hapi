import type { ComponentPropsWithoutRef } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import { SyntaxHighlighter } from '@/components/assistant-ui/shiki-highlighter'

// `SyntaxHighlighter` never actually uses `components.Pre`/`components.Code`
// (it renders its own markup directly), but the prop is required by
// `SyntaxHighlighterProps`, so pass through minimal stand-ins.
function StubPre(props: ComponentPropsWithoutRef<'pre'>) {
    return <pre {...props} />
}
function StubCode(props: ComponentPropsWithoutRef<'code'>) {
    return <code {...props} />
}

afterEach(() => cleanup())

// This is the component `@assistant-ui/react-markdown`'s DefaultCodeBlock
// actually renders for fenced code blocks that declare a language (the
// overwhelming majority of real assistant-message code blocks) — `Pre` is
// only used for the languageless fallback path. It must consume the same
// wrap preference and use the same per-line row layout as CodeBlock.
// In jsdom shiki never resolves, so these tests exercise the plain-text
// fallback, which shares the per-line structure with the highlighted path.
describe('SyntaxHighlighter wrap toggle', () => {
    beforeEach(() => {
        window.localStorage.clear()
    })

    it('renders the code inside a <pre> element for preformatted semantics', () => {
        const { container } = render(
            <I18nProvider>
                <SyntaxHighlighter code={'const a = 1\nconst b = 2'} language="typescript" components={{ Pre: StubPre, Code: StubCode }} />
            </I18nProvider>
        )

        const pre = container.querySelector('pre.shiki')
        expect(pre).not.toBeNull()
        expect(pre?.querySelector('[data-line-number]')).not.toBeNull()
        expect(pre?.querySelector('[data-code-cell]')).not.toBeNull()
    })

    it('defaults to wrap off: per-line rows, horizontal scroll, no wrapping', () => {
        const { container } = render(
            <I18nProvider>
                <SyntaxHighlighter code={'const a = 1\nconst b = 2'} language="typescript" components={{ Pre: StubPre, Code: StubCode }} />
            </I18nProvider>
        )

        expect(container.querySelectorAll('[data-line-number]')).toHaveLength(2)
        expect(container.querySelectorAll('[data-code-cell]')).toHaveLength(2)
        expect(container.querySelector('.overflow-x-auto')).not.toBeNull()
        const codeCell = container.querySelector('[data-code-cell]') as HTMLElement | null
        expect(codeCell?.style.whiteSpace).not.toBe('pre-wrap')
    })

    // The wrap CSS is applied via inline `style`, not a `whitespace-pre-wrap`
    // Tailwind class: `.aui-md :where(pre) { white-space: pre }` in index.css
    // is unlayered CSS that outranks any `@layer` regardless of specificity;
    // a class would silently lose inside `.aui-md` markdown code blocks
    // (found live in Phase 4 isolated E2E).
    it('reads the persisted wrap preference: keeps line numbers and wraps the code cells via inline style', () => {
        window.localStorage.setItem('hapi-code-wrap', '1')

        const { container } = render(
            <I18nProvider>
                <SyntaxHighlighter code={'const a = 1\nconst b = 2'} language="typescript" components={{ Pre: StubPre, Code: StubCode }} />
            </I18nProvider>
        )

        // Line numbers stay (per-line layout), not hidden.
        expect(container.querySelectorAll('[data-line-number]')).toHaveLength(2)
        expect(container.querySelector('.overflow-x-auto')).toBeNull()
        const codeCell = container.querySelector('[data-code-cell]') as HTMLElement | null
        expect(codeCell?.style.whiteSpace).toBe('pre-wrap')
    })

    it('renders the plain-text fallback as per-line rows', () => {
        const { container } = render(
            <I18nProvider>
                <SyntaxHighlighter code={'plain one\nplain two'} language="text" components={{ Pre: StubPre, Code: StubCode }} />
            </I18nProvider>
        )

        const codeCells = container.querySelectorAll('[data-code-cell]')
        expect(codeCells).toHaveLength(2)
        expect(codeCells[0]).toHaveTextContent('plain one')
        expect(codeCells[1]).toHaveTextContent('plain two')
    })
})
