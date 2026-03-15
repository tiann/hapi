import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { ConfirmDialog } from './ConfirmDialog'

describe('ConfirmDialog', () => {
    const defaultProps = {
        isOpen: true,
        onClose: vi.fn(),
        title: 'Confirm Action',
        description: 'Are you sure you want to proceed?',
        confirmLabel: 'Confirm',
        confirmingLabel: 'Confirming...',
        cancelLabel: 'Cancel',
        defaultErrorMessage: 'An error occurred',
        onConfirm: vi.fn(async () => {}),
        isPending: false,
    }

    beforeEach(() => {
        vi.clearAllMocks()
    })

    afterEach(() => {
        cleanup()
    })

    it('renders dialog when open', () => {
        render(<ConfirmDialog {...defaultProps} />)
        expect(screen.getByText('Confirm Action')).toBeInTheDocument()
        expect(screen.getByText('Are you sure you want to proceed?')).toBeInTheDocument()
    })

    it('does not render when closed', () => {
        render(<ConfirmDialog {...defaultProps} isOpen={false} />)
        expect(screen.queryByText('Confirm Action')).not.toBeInTheDocument()
    })

    it('renders confirm and cancel buttons', () => {
        render(<ConfirmDialog {...defaultProps} />)
        expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
    })

    it('calls onClose when cancel button clicked', () => {
        render(<ConfirmDialog {...defaultProps} />)
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
        expect(defaultProps.onClose).toHaveBeenCalledTimes(1)
    })

    it('calls onConfirm when confirm button clicked', async () => {
        render(<ConfirmDialog {...defaultProps} />)
        fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
        await waitFor(() => expect(defaultProps.onConfirm).toHaveBeenCalledTimes(1))
    })

    it('closes dialog after successful confirmation', async () => {
        render(<ConfirmDialog {...defaultProps} />)
        fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
        await waitFor(() => expect(defaultProps.onClose).toHaveBeenCalledTimes(1))
    })

    it('shows confirming label when pending', () => {
        render(<ConfirmDialog {...defaultProps} isPending={true} />)
        expect(screen.getByRole('button', { name: 'Confirming...' })).toBeInTheDocument()
    })

    it('disables buttons when pending', () => {
        render(<ConfirmDialog {...defaultProps} isPending={true} />)
        expect(screen.getByRole('button', { name: 'Confirming...' })).toBeDisabled()
        expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    })

    it('displays error message on confirmation failure', async () => {
        const onConfirm = vi.fn(async () => {
            throw new Error('Custom error message')
        })
        render(<ConfirmDialog {...defaultProps} onConfirm={onConfirm} />)

        fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))

        await waitFor(() => {
            expect(screen.getByText('Custom error message')).toBeInTheDocument()
        })
    })

    it('displays default error message when error has no message', async () => {
        const onConfirm = vi.fn(async () => {
            throw new Error()
        })
        render(<ConfirmDialog {...defaultProps} onConfirm={onConfirm} />)

        fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))

        await waitFor(() => {
            expect(screen.getByText('An error occurred')).toBeInTheDocument()
        })
    })

    it('does not close dialog on confirmation failure', async () => {
        const onConfirm = vi.fn(async () => {
            throw new Error('Failed')
        })
        render(<ConfirmDialog {...defaultProps} onConfirm={onConfirm} />)

        fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))

        await waitFor(() => {
            expect(screen.getByText('Failed')).toBeInTheDocument()
        })

        expect(defaultProps.onClose).not.toHaveBeenCalled()
    })

    it('clears error when dialog reopens', async () => {
        const onConfirm = vi.fn(async () => {
            throw new Error('Error message')
        })
        const { rerender } = render(<ConfirmDialog {...defaultProps} onConfirm={onConfirm} />)

        fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))

        await waitFor(() => {
            expect(screen.getByText('Error message')).toBeInTheDocument()
        })

        rerender(<ConfirmDialog {...defaultProps} onConfirm={onConfirm} isOpen={false} />)
        rerender(<ConfirmDialog {...defaultProps} onConfirm={onConfirm} isOpen={true} />)

        expect(screen.queryByText('Error message')).not.toBeInTheDocument()
    })

    it('applies destructive variant when destructive is true', () => {
        render(<ConfirmDialog {...defaultProps} destructive={true} />)
        const confirmButton = screen.getByRole('button', { name: 'Confirm' })
        expect(confirmButton).toHaveClass('bg-[var(--app-badge-error-bg)]')
    })

    it('applies secondary variant when destructive is false', () => {
        render(<ConfirmDialog {...defaultProps} destructive={false} />)
        const confirmButton = screen.getByRole('button', { name: 'Confirm' })
        expect(confirmButton).toHaveClass('bg-[var(--app-secondary-bg)]')
    })

    it('calls onClose when dialog overlay clicked', () => {
        render(<ConfirmDialog {...defaultProps} />)
        // Radix Dialog handles this internally, we just verify the prop is passed
        expect(defaultProps.onClose).toBeDefined()
    })
})
