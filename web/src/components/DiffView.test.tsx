import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import { DiffView } from '@/components/DiffView'

afterEach(() => cleanup())

describe('DiffView', () => {
    beforeEach(() => {
        window.localStorage.clear()
    })

    it('counts blank-line additions and removals in diff stats', () => {
        render(
            <I18nProvider>
                <DiffView
                    oldString={'line 1\n\nline 3\n'}
                    newString={'line 1\nline 3\n\n'}
                    filePath="example.ts"
                    variant="inline"
                />
            </I18nProvider>
        )

        expect(screen.getByText('+1')).toBeInTheDocument()
        expect(screen.getByText('-1')).toBeInTheDocument()
        expect(screen.getByText('example.ts')).toBeInTheDocument()
    })

    it('renders a single visible header in preview mode', () => {
        render(
            <I18nProvider>
                <DiffView
                    oldString={'before\n'}
                    newString={'after\n'}
                    filePath="single-header.ts"
                />
            </I18nProvider>
        )

        expect(screen.getAllByText('single-header.ts')).toHaveLength(1)
    })

    it('reports zero lines for an empty side of the diff', () => {
        render(
            <I18nProvider>
                <DiffView oldString="" newString={'created\n'} />
            </I18nProvider>
        )

        expect(screen.getByText('0 → 1 lines')).toBeInTheDocument()
        expect(screen.getAllByText('+1').length).toBeGreaterThan(0)
    })

    it('keeps comfortable diff rows left-aligned with aligned line-number columns', () => {
        const oldString = Array.from({ length: 123 }, (_, index) => `old ${index + 1}`).join('\n')
        const newString = `${oldString}\nnew line`
        const { container } = render(
            <I18nProvider>
                <DiffView
                    oldString={oldString}
                    newString={newString}
                    variant="inline"
                    size="comfortable"
                />
            </I18nProvider>
        )

        expect(container.querySelector('.leading-6')).not.toBeNull()
        const row = container.querySelector('[style*="grid-template-columns: 3ch 3ch max-content"]')
        expect(row).not.toBeNull()
        expect(row?.children[0]).toHaveClass('text-left')
        expect(row?.children[1]).toHaveClass('text-left')
    })

    it('comfortable rows default to whitespace-pre (wrap off, no toggle button on DiffView)', () => {
        const { container } = render(
            <I18nProvider>
                <DiffView
                    oldString={'old line\n'}
                    newString={'a very long new line that would need to wrap to avoid horizontal scroll on narrow screens\n'}
                    variant="inline"
                    size="comfortable"
                />
            </I18nProvider>
        )

        expect(container.querySelector('.whitespace-pre:not(.whitespace-pre-wrap)')).not.toBeNull()
        // DiffView consumes the global wrap value but exposes no toggle
        // button; assert by aria-pressed absence rather than a localized title.
        expect(screen.queryByRole('button', { pressed: false })).toBeNull()
        expect(screen.queryByRole('button', { pressed: true })).toBeNull()
    })

    it('compact rows also follow the global wrap preference (previously hard-coded to wrap)', () => {
        const props = {
            oldString: 'old line\n',
            newString: 'a very long new line that would need to wrap to avoid horizontal scroll on narrow screens\n',
            variant: 'inline' as const,
            size: 'compact' as const
        }

        // wrap off (default): compact rows now use whitespace-pre + horizontal scroll
        const off = render(<I18nProvider><DiffView {...props} /></I18nProvider>)
        expect(off.container.querySelector('.whitespace-pre:not(.whitespace-pre-wrap)')).not.toBeNull()
        expect(off.container.querySelector('.overflow-x-auto')).not.toBeNull()
        off.unmount()

        // wrap on: compact rows wrap and drop the horizontal-scroll container
        window.localStorage.setItem('hapi-code-wrap', '1')
        const on = render(<I18nProvider><DiffView {...props} /></I18nProvider>)
        expect(on.container.querySelector('.whitespace-pre-wrap')).not.toBeNull()
        expect(on.container.querySelector('.overflow-x-auto')).toBeNull()
    })

    it('comfortable rows consume the global wrap preference from localStorage', () => {
        window.localStorage.setItem('hapi-code-wrap', '1')

        const { container } = render(
            <I18nProvider>
                <DiffView
                    oldString={'old line\n'}
                    newString={'a very long new line that would need to wrap to avoid horizontal scroll on narrow screens\n'}
                    variant="inline"
                    size="comfortable"
                />
            </I18nProvider>
        )

        expect(container.querySelector('.whitespace-pre-wrap')).not.toBeNull()
        expect(container.querySelector('.whitespace-pre:not(.whitespace-pre-wrap)')).toBeNull()
    })

    it('wrap on drops the horizontal-scroll container and max-content grid track (Phase 1 lesson applied here too)', () => {
        // Same trap as CodeBlock's Phase 1 spike: `whitespace-pre-wrap` alone
        // does nothing if the row's grid track is `max-content` and an
        // ancestor is `w-max` inside `overflow-x-auto` — the row still
        // claims full content width before wrapping is ever evaluated.
        window.localStorage.setItem('hapi-code-wrap', '1')

        const { container } = render(
            <I18nProvider>
                <DiffView
                    oldString={'old line\n'}
                    newString={'a very long new line that would need to wrap to avoid horizontal scroll on narrow screens\n'}
                    variant="inline"
                    size="comfortable"
                />
            </I18nProvider>
        )

        expect(container.querySelector('.overflow-x-auto')).toBeNull()
        expect(container.querySelector('[style*="max-content"]')).toBeNull()
    })

    it('wrap on keeps line-number columns aligned across all rows (grid-per-line structure)', () => {
        const oldString = Array.from({ length: 12 }, (_, index) => `old ${index + 1}`).join('\n')
        const newString = `${oldString}\na very long new line that would need to wrap to avoid horizontal scroll on narrow screens`
        window.localStorage.setItem('hapi-code-wrap', '1')

        const { container } = render(
            <I18nProvider>
                <DiffView
                    oldString={oldString}
                    newString={newString}
                    variant="inline"
                    size="comfortable"
                />
            </I18nProvider>
        )

        const rows = Array.from(container.querySelectorAll('[style*="grid-template-columns"]'))
        expect(rows.length).toBeGreaterThan(1)
        const templates = new Set(rows.map((row) => (row as HTMLElement).style.gridTemplateColumns))
        // Every row must share the exact same column template so line
        // numbers stay pixel-aligned regardless of how many visual lines a
        // wrapped row occupies.
        expect(templates.size).toBe(1)
    })
})
