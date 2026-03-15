import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DiffView } from './DiffView'

// Mock translation hook
vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({
        t: (key: string) => {
            const translations: Record<string, string> = {
                'diff.title': 'Diff',
                'diff.view': 'View',
            }
            return translations[key] || key
        },
    }),
}))

describe('DiffView', () => {
    it('renders preview variant with trigger button', () => {
        render(
            <DiffView
                oldString="Hello world"
                newString="Hello React"
                variant="preview"
            />
        )

        expect(screen.getByText('View')).toBeInTheDocument()
    })

    it('renders inline variant without dialog', () => {
        const { container } = render(
            <DiffView
                oldString="line 1\nline 2"
                newString="line 1\nline 3"
                variant="inline"
            />
        )

        // Should render diff directly without dialog trigger
        expect(container.querySelector('.font-mono')).toBeInTheDocument()
    })

    it('displays file path when provided', () => {
        render(
            <DiffView
                oldString="old"
                newString="new"
                filePath="/src/test.ts"
                variant="inline"
            />
        )

        expect(screen.getByText('/src/test.ts')).toBeInTheDocument()
    })

    it('shows character count stats', () => {
        render(
            <DiffView
                oldString="abc"
                newString="abcdef"
                variant="preview"
            />
        )

        // Should show stats in the preview
        const statsText = screen.getByText(/3.*chars.*6.*chars/i)
        expect(statsText).toBeInTheDocument()
    })

    it('renders diff with added lines', () => {
        const { container } = render(
            <DiffView
                oldString="line 1"
                newString="line 1\nline 2"
                variant="inline"
            />
        )

        const diffContainer = container.querySelector('.font-mono')
        expect(diffContainer).toBeInTheDocument()
        expect(diffContainer?.textContent).toMatch(/\+.*line 2/)
    })

    it('renders diff with removed lines', () => {
        const { container } = render(
            <DiffView
                oldString="line 1\nline 2"
                newString="line 1"
                variant="inline"
            />
        )

        const diffContainer = container.querySelector('.font-mono')
        expect(diffContainer).toBeInTheDocument()
        expect(diffContainer?.textContent).toMatch(/-.*line 2/)
    })

    it('renders diff with unchanged lines', () => {
        const { container } = render(
            <DiffView
                oldString="same line"
                newString="same line"
                variant="inline"
            />
        )

        const diffContainer = container.querySelector('.font-mono')
        expect(diffContainer).toBeInTheDocument()
        expect(diffContainer?.textContent).toContain('  same line')
    })
})
