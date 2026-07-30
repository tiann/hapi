import type { ComponentType } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import { defaultComponents } from '@/components/assistant-ui/markdown-text'

afterEach(() => cleanup())

// Render the exact components the markdown pipeline wires up for a fenced
// code block: `defaultComponents.CodeHeader` (the toggle header) and
// `defaultComponents.pre` (the languageless-fallback body). Going through
// `defaultComponents` keeps the test on the real production render path
// without widening the module's public surface. `memoizeMarkdownComponents`
// narrows the memoized components to `{ node? }` props, so cast to feed the
// real runtime props the pipeline passes.
const CodeHeader = defaultComponents.CodeHeader as ComponentType<{ language?: string; code: string }>
const Pre = defaultComponents.pre as ComponentType<{ children: string }>

describe('markdown-text CodeHeader + Pre wrap toggle', () => {
    beforeEach(() => {
        window.localStorage.clear()
    })

    it('defaults to wrap off: Pre keeps the horizontal-scroll wrapper and w-max pre', () => {
        const { container } = render(
            <I18nProvider>
                <CodeHeader language="typescript" code="const a = 1" />
                <Pre>const a = 1</Pre>
            </I18nProvider>
        )

        expect(container.querySelector('.overflow-x-auto')).not.toBeNull()
        expect(container.querySelector('.aui-md-pre')).toHaveClass('w-max')
        expect((container.querySelector('.aui-md-pre') as HTMLElement | null)?.style.whiteSpace).not.toBe('pre-wrap')
    })

    // The wrap CSS is applied via inline `style`, not a `whitespace-pre-wrap`
    // Tailwind class: `.aui-md :where(pre) { white-space: pre }` in
    // index.css is unlayered CSS, which the cascade always ranks above ANY
    // `@layer` (including Tailwind's own `utilities` layer) regardless of
    // selector specificity — a class-based approach silently loses inside
    // `.aui-md` markdown code blocks (found live in Phase 4 isolated E2E).
    it('toggling wrap on from CodeHeader flips Pre to inline whitespace-pre-wrap with no horizontal scroll', () => {
        const { container } = render(
            <I18nProvider>
                <CodeHeader language="typescript" code="const a = 1" />
                <Pre>const a = 1</Pre>
            </I18nProvider>
        )

        // Select the toggle by aria-pressed state, not its localized title.
        fireEvent.click(screen.getByRole('button', { pressed: false }))

        expect(container.querySelector('.overflow-x-auto')).toBeNull()
        expect((container.querySelector('.aui-md-pre') as HTMLElement | null)?.style.whiteSpace).toBe('pre-wrap')
        expect(container.querySelector('.aui-md-pre')).not.toHaveClass('w-max')
        expect(screen.getByRole('button', { pressed: true })).toBeInTheDocument()
    })

    it('reads the persisted wrap preference on mount', () => {
        window.localStorage.setItem('hapi-code-wrap', '1')

        const { container } = render(
            <I18nProvider>
                <CodeHeader language="typescript" code="const a = 1" />
                <Pre>const a = 1</Pre>
            </I18nProvider>
        )

        expect((container.querySelector('.aui-md-pre') as HTMLElement | null)?.style.whiteSpace).toBe('pre-wrap')
        expect(screen.getByRole('button', { pressed: true })).toBeInTheDocument()
    })
})
