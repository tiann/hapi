import { describe, expect, it, vi, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import { DeleteSessionDialog } from './DeleteSessionDialog'

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
    Button: ({ children, onClick, disabled, type, variant }: {
        children: React.ReactNode
        onClick?: () => void
        disabled?: boolean
        type?: string
        variant?: string
    }) => (
        <button onClick={onClick} disabled={disabled} type={type} data-variant={variant}>
            {children}
        </button>
    )
}))

describe('DeleteSessionDialog', () => {
    afterEach(() => {
        cleanup()
    })

    it('renders dialog when open', () => {
        render(
            <DeleteSessionDialog
                isOpen={true}
                onClose={vi.fn()}
                sessionName="Test Session"
                onDelete={vi.fn()}
                isPending={false}
            />
        )

        expect(screen.getByTestId('dialog')).toBeInTheDocument()
        expect(screen.getByText('dialog.delete.title')).toBeInTheDocument()
        expect(screen.getByText(/dialog.delete.description/)).toBeInTheDocument()
    })

    it('does not render when closed', () => {
        render(
            <DeleteSessionDialog
                isOpen={false}
                onClose={vi.fn()}
                sessionName="Test Session"
                onDelete={vi.fn()}
                isPending={false}
            />
        )

        expect(screen.queryByTestId('dialog')).not.toBeInTheDocument()
    })

    it('displays session name in description', () => {
        render(
            <DeleteSessionDialog
                isOpen={true}
                onClose={vi.fn()}
                sessionName="Critical Session"
                onDelete={vi.fn()}
                isPending={false}
            />
        )

        expect(screen.getByText(/"Critical Session"/)).toBeInTheDocument()
    })

    it('calls onDelete and onClose when confirm button clicked', async () => {
        const onDelete = vi.fn().mockResolvedValue(undefined)
        const onClose = vi.fn()

        render(
            <DeleteSessionDialog
                isOpen={true}
                onClose={onClose}
                sessionName="Test"
                onDelete={onDelete}
                isPending={false}
            />
        )

        const confirmButton = screen.getByText('dialog.delete.confirm')
        fireEvent.click(confirmButton)

        await waitFor(() => {
            expect(onDelete).toHaveBeenCalled()
            expect(onClose).toHaveBeenCalled()
        })
    })

    it('calls onClose when cancel button clicked', async () => {
        const onClose = vi.fn()

        render(
            <DeleteSessionDialog
                isOpen={true}
                onClose={onClose}
                sessionName="Test"
                onDelete={vi.fn()}
                isPending={false}
            />
        )

        const cancelButton = screen.getByText('button.cancel')
        fireEvent.click(cancelButton)

        expect(onClose).toHaveBeenCalled()
    })

    it('disables buttons when pending', () => {
        render(
            <DeleteSessionDialog
                isOpen={true}
                onClose={vi.fn()}
                sessionName="Test"
                onDelete={vi.fn()}
                isPending={true}
            />
        )

        const confirmButton = screen.getByText('dialog.delete.deleting')
        const cancelButton = screen.getByText('button.cancel')

        expect(confirmButton).toBeDisabled()
        expect(cancelButton).toBeDisabled()
    })

    it('shows deleting text when pending', () => {
        render(
            <DeleteSessionDialog
                isOpen={true}
                onClose={vi.fn()}
                sessionName="Test"
                onDelete={vi.fn()}
                isPending={true}
            />
        )

        expect(screen.getByText('dialog.delete.deleting')).toBeInTheDocument()
    })

    it('shows confirm text when not pending', () => {
        render(
            <DeleteSessionDialog
                isOpen={true}
                onClose={vi.fn()}
                sessionName="Test"
                onDelete={vi.fn()}
                isPending={false}
            />
        )

        expect(screen.getByText('dialog.delete.confirm')).toBeInTheDocument()
    })

    it('renders delete button with destructive variant', () => {
        render(
            <DeleteSessionDialog
                isOpen={true}
                onClose={vi.fn()}
                sessionName="Test"
                onDelete={vi.fn()}
                isPending={false}
            />
        )

        const confirmButton = screen.getByText('dialog.delete.confirm')
        expect(confirmButton).toHaveAttribute('data-variant', 'destructive')
    })
})
