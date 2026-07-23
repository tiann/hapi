import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import { CodeBlock } from '@/components/CodeBlock'

afterEach(() => cleanup())

// In jsdom the async shiki highlighter never resolves, so these tests
// exercise the plain-text fallback (code split on newlines), which is the
// same per-line row structure the highlighted path produces.

describe('CodeBlock', () => {
    beforeEach(() => {
        window.localStorage.clear()
    })

    it('renders a header label and truncation badge for long content', () => {
        const longCode = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join('\n')
        render(
            <I18nProvider>
                <CodeBlock
                    code={longCode}
                    language="typescript"
                    title="TypeScript"
                    collapseLongContent
                    collapseLineThreshold={5}
                />
            </I18nProvider>
        )

        expect(screen.getByText('TypeScript')).toBeInTheDocument()
        expect(screen.getByTitle('Copy')).toBeInTheDocument()
        expect(screen.getByText(/Preview truncated/)).toBeInTheDocument()
    })

    it('renders one line-number cell per source line, aligned with the code', () => {
        const { container } = render(
            <I18nProvider>
                <CodeBlock code={'const a = 1\nconst b = 2\nconst c = 3'} language="typescript" />
            </I18nProvider>
        )

        const lineNumbers = container.querySelectorAll('[data-line-number]')
        expect(lineNumbers).toHaveLength(3)
        expect(Array.from(lineNumbers).map((el) => el.textContent)).toEqual(['1', '2', '3'])
    })

    it('renders the code inside a <pre> element for preformatted semantics', () => {
        const { container } = render(
            <I18nProvider>
                <CodeBlock code={'const a = 1\nconst b = 2'} language="typescript" />
            </I18nProvider>
        )

        const pre = container.querySelector('pre.shiki')
        expect(pre).not.toBeNull()
        expect(pre?.querySelector('[data-line-number]')).not.toBeNull()
        expect(pre?.querySelector('[data-code-cell]')).not.toBeNull()
    })

    it('defaults to wrap off: line-number column present, horizontal scroll container, no wrapping', () => {
        const { container } = render(
            <I18nProvider>
                <CodeBlock code={'const a = 1\nconst b = 2'} language="typescript" />
            </I18nProvider>
        )

        expect(container.querySelector('[data-line-number]')).not.toBeNull()
        expect(container.querySelector('.overflow-x-auto')).not.toBeNull()
        const codeCell = container.querySelector('[data-code-cell]') as HTMLElement | null
        expect(codeCell?.style.whiteSpace).not.toBe('pre-wrap')
    })

    it('toggling wrap on keeps the line-number column and wraps the code cells (no horizontal scroll)', () => {
        // Select the toggle by its aria-pressed state, not its localized title.
        const { container } = render(
            <I18nProvider>
                <CodeBlock code={'const a = 1\nconst b = 2'} language="typescript" />
            </I18nProvider>
        )

        fireEvent.click(screen.getByRole('button', { pressed: false }))

        // Line numbers stay (this is the whole point of the per-line layout).
        expect(container.querySelectorAll('[data-line-number]')).toHaveLength(2)
        expect(container.querySelector('.overflow-x-auto')).toBeNull()
        const codeCell = container.querySelector('[data-code-cell]') as HTMLElement | null
        expect(codeCell?.style.whiteSpace).toBe('pre-wrap')
        expect(screen.getByRole('button', { pressed: true })).toBeInTheDocument()
    })

    it('reads the persisted wrap preference on mount and still keeps line numbers', () => {
        window.localStorage.setItem('hapi-code-wrap', '1')

        const { container } = render(
            <I18nProvider>
                <CodeBlock code={'const a = 1\nconst b = 2'} language="typescript" />
            </I18nProvider>
        )

        expect(container.querySelectorAll('[data-line-number]')).toHaveLength(2)
        const codeCell = container.querySelector('[data-code-cell]') as HTMLElement | null
        expect(codeCell?.style.whiteSpace).toBe('pre-wrap')
        expect(screen.getByRole('button', { pressed: true })).toBeInTheDocument()
    })

    it('renders the plain-text fallback as per-line rows when highlighting is unavailable', () => {
        const { container } = render(
            <I18nProvider>
                <CodeBlock code={'plain one\nplain two'} language="text" />
            </I18nProvider>
        )

        const codeCells = container.querySelectorAll('[data-code-cell]')
        expect(codeCells).toHaveLength(2)
        expect(codeCells[0]).toHaveTextContent('plain one')
        expect(codeCells[1]).toHaveTextContent('plain two')
        expect(container.querySelectorAll('[data-line-number]')).toHaveLength(2)
    })

    it('renders the wrap toggle button by default', () => {
        render(
            <I18nProvider>
                <CodeBlock code="const a = 1" language="typescript" />
            </I18nProvider>
        )

        expect(screen.getByRole('button', { pressed: false })).toBeInTheDocument()
    })

    it('omits the wrap toggle button when showWrapToggle is false', () => {
        // The wrap toggle is a <button>. When CodeBlock renders inside an
        // interactive ancestor (DialogTrigger's button, a role="button"
        // preview), that nested <button> is invalid HTML / a hydration
        // violation. Such callsites pass showWrapToggle={false}.
        render(
            <I18nProvider>
                <CodeBlock code="const a = 1" language="typescript" showWrapToggle={false} />
            </I18nProvider>
        )

        // The toggle is the only button carrying aria-pressed.
        expect(screen.queryByRole('button', { pressed: false })).toBeNull()
        expect(screen.queryByRole('button', { pressed: true })).toBeNull()
    })
})
