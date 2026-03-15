import { describe, expect, it, vi, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import { RenameSessionDialog } from './RenameSessionDialog'

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
    DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>
}))

vi.mock('@/shared/ui/button', () => ({
    Button: ({ children, onClick, disabled, type }: {
        children: React.ReactNode
        onClick?: () => void
        disabled?: boolean
        type?: string
    }) => (
        <button onClick={onClick} disabled={disabled} type={type}>
            {children}
        </button>
    )
}))

describe('RenameSessionDialog', () => {
    afterEach(() => {
        cleanup()
    })

    it('renders dialog when open', () => {
        render(
            <RenameSessionDialog
                isOpen={true}
                onClose={vi.fn()}
                currentName="Test Session"
                onRename={vi.fn()}
                isPending={false}
            />
        )

        expect(screen.getByTestId('dialog')).toBeInTheDocument()
        expect(screen.getByText('dialog.rename.title')).toBeInTheDocument()
    })

    it('does not render when closed', () => {
        render(
            <RenameSessionDialog
                isOpen={false}
                onClose={vi.fn()}
                currentName="Test Session"
                onRename={vi.fn()}
                isPending={false}
            />
        )

        expect(screen.queryByTestId('dialog')).not.toBeInTheDocument()
    })

    it('displays current name in input', () => {
        render(
            <RenameSessionDialog
                isOpen={true}
                onClose={vi.fn()}
                currentName="My Session"
                onRename={vi.fn()}
                isPending={false}
            />
        )

        const input = screen.getByPlaceholderText('dialog.rename.placeholder') as HTMLInputElement
        expect(input.value).toBe('My Session')
    })

    it('calls onRename with new name on submit', async () => {
        const onRename = vi.fn().mockResolvedValue(undefined)
        const onClose = vi.fn()

        render(
            <RenameSessionDialog
                isOpen={true}
                onClose={onClose}
                currentName="Old Name"
                onRename={onRename}
                isPending={false}
            />
        )

        const input = screen.getByPlaceholderText('dialog.rename.placeholder')
        fireEvent.change(input, { target: { value: 'New Name' } })

        const saveButton = screen.getByText('button.save')
        fireEvent.click(saveButton)

        await waitFor(() => {
            expect(onRename).toHaveBeenCalledWith('New Name')
            expect(onClose).toHaveBeenCalled()
        })
    })

    it('closes dialog without calling onRename if name unchanged', async () => {
        const onRename = vi.fn()
        const onClose = vi.fn()

        render(
            <RenameSessionDialog
                isOpen={true}
                onClose={onClose}
                currentName="Same Name"
                onRename={onRename}
                isPending={false}
            />
        )

        const saveButton = screen.getByText('button.save')
        fireEvent.click(saveButton)

        expect(onRename).not.toHaveBeenCalled()
        expect(onClose).toHaveBeenCalled()
    })

    it('closes dialog without calling onRename if name is empty', async () => {
        const onRename = vi.fn()
        const onClose = vi.fn()

        const { container } = render(
            <RenameSessionDialog
                isOpen={true}
                onClose={onClose}
                currentName="Old Name"
                onRename={onRename}
                isPending={false}
            />
        )

        const input = screen.getByPlaceholderText('dialog.rename.placeholder')
        fireEvent.change(input, { target: { value: '   ' } })

        const form = container.querySelector('form')
        if (form) {
            fireEvent.submit(form)
        }

        expect(onRename).not.toHaveBeenCalled()
        expect(onClose).toHaveBeenCalled()
    })

    it('displays error message when rename fails', async () => {
        const onRename = vi.fn().mockRejectedValue(new Error('Failed'))

        render(
            <RenameSessionDialog
                isOpen={true}
                onClose={vi.fn()}
                currentName="Old Name"
                onRename={onRename}
                isPending={false}
            />
        )

        const input = screen.getByPlaceholderText('dialog.rename.placeholder')
        fireEvent.change(input, { target: { value: 'New Name' } })

        const saveButton = screen.getByText('button.save')
        fireEvent.click(saveButton)

        await waitFor(() => {
            expect(screen.getByText('dialog.rename.error')).toBeInTheDocument()
        })
    })

    it('calls onClose when cancel button clicked', async () => {
        const onClose = vi.fn()

        render(
            <RenameSessionDialog
                isOpen={true}
                onClose={onClose}
                currentName="Test"
                onRename={vi.fn()}
                isPending={false}
            />
        )

        const cancelButton = screen.getByText('button.cancel')
        fireEvent.click(cancelButton)

        expect(onClose).toHaveBeenCalled()
    })

    it('disables buttons when pending', () => {
        render(
            <RenameSessionDialog
                isOpen={true}
                onClose={vi.fn()}
                currentName="Test"
                onRename={vi.fn()}
                isPending={true}
            />
        )

        const saveButton = screen.getByText('dialog.rename.saving')
        const cancelButton = screen.getByText('button.cancel')

        expect(saveButton).toBeDisabled()
        expect(cancelButton).toBeDisabled()
    })

    it('disables save button when input is empty', async () => {
        render(
            <RenameSessionDialog
                isOpen={true}
                onClose={vi.fn()}
                currentName="Test"
                onRename={vi.fn()}
                isPending={false}
            />
        )

        const input = screen.getByPlaceholderText('dialog.rename.placeholder')
        fireEvent.change(input, { target: { value: '' } })

        const saveButton = screen.getByText('button.save')
        expect(saveButton).toBeDisabled()
    })
})
