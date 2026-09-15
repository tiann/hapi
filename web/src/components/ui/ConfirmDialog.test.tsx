import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { ConfirmDialog } from './ConfirmDialog'

function renderDialog(centerTitle = false) {
    render(
        <I18nProvider>
            <ConfirmDialog
                isOpen={true}
                onClose={vi.fn()}
                title="Archive Session"
                description="Archive this session?"
                confirmLabel="Archive"
                confirmingLabel="Archiving..."
                onConfirm={vi.fn(async () => {})}
                isPending={false}
                centerTitle={centerTitle}
            />
        </I18nProvider>
    )
}

describe('ConfirmDialog', () => {
    it('centers an opted-in title on the close button centerline', () => {
        renderDialog(true)

        const dialog = screen.getByRole('dialog')
        const title = within(dialog).getByRole('heading', { name: 'Archive Session' })
        const description = within(dialog).getByText('Archive this session?')

        expect(title.parentElement).toHaveClass('pr-0')
        expect(title).toHaveClass('min-h-6', 'w-full', 'px-10', 'text-center', 'leading-6', 'max-sm:translate-x-1', 'max-sm:translate-y-px')
        expect(description).toHaveClass('mt-2', 'text-left')
        expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveClass('top-3', 'h-8')
    })

    it('keeps the default dialog title layout when centering is not requested', () => {
        renderDialog()

        const title = screen.getByRole('heading', { name: 'Archive Session' })

        expect(title.parentElement).toHaveClass('pr-12')
        expect(title).not.toHaveClass('min-h-6', 'px-10', 'leading-6')
    })
})
