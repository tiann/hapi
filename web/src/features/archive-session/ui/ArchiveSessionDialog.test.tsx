import { describe, expect, it, vi, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import { ArchiveSessionDialog } from './ArchiveSessionDialog'

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({
        t: (key: string) => key
    })
}))

vi.mock('@/shared/ui/dialog', () => ({
    Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
        open ? <div data-testid="dialog">{children}</div> : null,
    DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
    DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>
}))

vi.mock('@/shared/ui/button', () => ({
    Button: ({ children, onClick, disabled, type }: {
        children: React.ReactNode
        onClick?: () => void
        disabled?: boolean
        type?: 'button' | 'submit' | 'reset'
    }) => (
        <button onClick={onClick} disabled={disabled} type={type}>
            {children}
        </button>
    )
}))

describe('ArchiveSessionDialog', () => {
    afterEach(() => {
        cleanup()
    })

    it('renders dialog when open', () => {
        render(
            <ArchiveSessionDialog
                isOpen={true}
                onClose={vi.fn()}
                sessionName="Test Session"
                onArchive={vi.fn()}
                isPending={false}
            />
        )

        expect(screen.getByTestId('dialog')).toBeInTheDocument()
        expect(screen.getByText('dialog.archive.title')).toBeInTheDocument()
        expect(screen.getByText(/dialog.archive.description/)).toBeInTheDocument()
    })

    it('does not render when closed', () => {
        render(
            <ArchiveSessionDialog
                isOpen={false}
                onClose={vi.fn()}
                sessionName="Test Session"
                onArchive={vi.fn()}
                isPending={false}
            />
        )

        expect(screen.queryByTestId('dialog')).not.toBeInTheDocument()
    })

    it('displays session name in description', () => {
        render(
            <ArchiveSessionDialog
                isOpen={true}
                onClose={vi.fn()}
                sessionName="My Important Session"
                onArchive={vi.fn()}
                isPending={false}
            />
        )

        expect(screen.getByText(/"My Important Session"/)).toBeInTheDocument()
    })

    it('calls onArchive and onClose when confirm button clicked', async () => {
        const onArchive = vi.fn().mockResolvedValue(undefined)
        const onClose = vi.fn()

        render(
            <ArchiveSessionDialog
                isOpen={true}
                onClose={onClose}
                sessionName="Test"
                onArchive={onArchive}
                isPending={false}
            />
        )

        const confirmButton = screen.getByText('dialog.archive.confirm')
        fireEvent.click(confirmButton)

        await waitFor(() => {
            expect(onArchive).toHaveBeenCalled()
            expect(onClose).toHaveBeenCalled()
        })
    })

    it('calls onClose when cancel button clicked', async () => {
        const onClose = vi.fn()

        render(
            <ArchiveSessionDialog
                isOpen={true}
                onClose={onClose}
                sessionName="Test"
                onArchive={vi.fn()}
                isPending={false}
            />
        )

        const cancelButton = screen.getByText('button.cancel')
        fireEvent.click(cancelButton)

        expect(onClose).toHaveBeenCalled()
    })

    it('disables buttons when pending', () => {
        render(
            <ArchiveSessionDialog
                isOpen={true}
                onClose={vi.fn()}
                sessionName="Test"
                onArchive={vi.fn()}
                isPending={true}
            />
        )

        const confirmButton = screen.getByText('dialog.archive.archiving')
        const cancelButton = screen.getByText('button.cancel')

        expect(confirmButton).toBeDisabled()
        expect(cancelButton).toBeDisabled()
    })

    it('shows archiving text when pending', () => {
        render(
            <ArchiveSessionDialog
                isOpen={true}
                onClose={vi.fn()}
                sessionName="Test"
                onArchive={vi.fn()}
                isPending={true}
            />
        )

        expect(screen.getByText('dialog.archive.archiving')).toBeInTheDocument()
    })

    it('shows confirm text when not pending', () => {
        render(
            <ArchiveSessionDialog
                isOpen={true}
                onClose={vi.fn()}
                sessionName="Test"
                onArchive={vi.fn()}
                isPending={false}
            />
        )

        expect(screen.getByText('dialog.archive.confirm')).toBeInTheDocument()
    })
})
