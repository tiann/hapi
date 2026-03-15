import { describe, expect, it, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { Toast } from './Toast'

describe('Toast', () => {
    afterEach(() => {
        cleanup()
    })

    it('renders toast with title', () => {
        render(<Toast title="Success" />)
        expect(screen.getByText('Success')).toBeInTheDocument()
    })

    it('renders toast with title and body', () => {
        render(<Toast title="Toast Title" body="Operation completed successfully" />)
        expect(screen.getByText('Toast Title')).toBeInTheDocument()
        expect(screen.getByText('Operation completed successfully')).toBeInTheDocument()
    })

    it('renders without body when not provided', () => {
        render(<Toast title="Title only" />)
        expect(screen.getByText('Title only')).toBeInTheDocument()
    })

    it('renders close button when onClose provided', () => {
        const onClose = vi.fn()
        const { getByLabelText } = render(<Toast title="Closable" onClose={onClose} />)
        expect(getByLabelText('Dismiss')).toBeInTheDocument()
    })

    it('does not render close button when onClose not provided', () => {
        const { queryByLabelText } = render(<Toast title="Not closable" />)
        expect(queryByLabelText('Dismiss')).not.toBeInTheDocument()
    })

    it('calls onClose when close button clicked', () => {
        const onClose = vi.fn()
        const { getByLabelText } = render(<Toast title="Clickable" onClose={onClose} />)

        const closeButton = getByLabelText('Dismiss')
        fireEvent.click(closeButton)

        expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('stops propagation on close button click', () => {
        const onClose = vi.fn()
        const onClick = vi.fn()
        const { getByLabelText } = render(
            <div onClick={onClick}>
                <Toast title="Propagation Test" onClose={onClose} />
            </div>
        )

        const closeButton = getByLabelText('Dismiss')
        fireEvent.click(closeButton)

        expect(onClose).toHaveBeenCalledTimes(1)
        expect(onClick).not.toHaveBeenCalled()
    })

    it('applies default variant', () => {
        const { container } = render(<Toast title="Default" />)
        const toast = container.querySelector('[role="status"]')
        expect(toast).toHaveClass('border-[var(--app-border)]')
        expect(toast).toHaveClass('bg-[var(--app-bg)]')
    })

    it('accepts custom className', () => {
        const { container } = render(<Toast title="Custom" className="custom-class" />)
        const toast = container.querySelector('[role="status"]')
        expect(toast).toHaveClass('custom-class')
    })

    it('has role="status" for accessibility', () => {
        const { getByRole } = render(<Toast title="Accessible" />)
        expect(getByRole('status')).toBeInTheDocument()
    })

    it('applies base styles', () => {
        const { container } = render(<Toast title="Styled" />)
        const toast = container.querySelector('[role="status"]')
        expect(toast).toHaveClass('pointer-events-auto')
        expect(toast).toHaveClass('rounded-lg')
        expect(toast).toHaveClass('shadow-lg')
    })

    it('passes through HTML div attributes', () => {
        render(<Toast title="Test" data-testid="custom-toast" />)
        expect(screen.getByTestId('custom-toast')).toBeInTheDocument()
    })
})
