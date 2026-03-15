import { describe, expect, it, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { Badge } from './badge'

describe('Badge', () => {
    afterEach(() => {
        cleanup()
    })
    it('renders badge with text', () => {
        render(<Badge>New</Badge>)
        expect(screen.getByText('New')).toBeInTheDocument()
    })

    it('applies default variant', () => {
        render(<Badge>Default</Badge>)
        const badge = screen.getByText('Default')
        expect(badge).toHaveClass('border-[var(--app-border)]')
        expect(badge).toHaveClass('bg-[var(--app-subtle-bg)]')
    })

    it('applies warning variant', () => {
        render(<Badge variant="warning">Warning</Badge>)
        const badge = screen.getByText('Warning')
        expect(badge).toHaveClass('border-[var(--app-badge-warning-border)]')
        expect(badge).toHaveClass('bg-[var(--app-badge-warning-bg)]')
    })

    it('applies success variant', () => {
        render(<Badge variant="success">Success</Badge>)
        const badge = screen.getByText('Success')
        expect(badge).toHaveClass('border-[var(--app-badge-success-border)]')
        expect(badge).toHaveClass('bg-[var(--app-badge-success-bg)]')
    })

    it('applies destructive variant', () => {
        render(<Badge variant="destructive">Error</Badge>)
        const badge = screen.getByText('Error')
        expect(badge).toHaveClass('border-[var(--app-badge-error-border)]')
        expect(badge).toHaveClass('bg-[var(--app-badge-error-bg)]')
    })

    it('accepts custom className', () => {
        render(<Badge className="custom-class">Custom</Badge>)
        const badge = screen.getByText('Custom')
        expect(badge).toHaveClass('custom-class')
    })

    it('renders as div element', () => {
        const { container } = render(<Badge>Badge</Badge>)
        expect(container.querySelector('div')).toBeInTheDocument()
    })

    it('passes through HTML div attributes', () => {
        render(
            <Badge data-testid="test-badge" title="Badge title">
                Badge
            </Badge>
        )
        const badge = screen.getByTestId('test-badge')
        expect(badge).toHaveAttribute('title', 'Badge title')
    })

    it('has correct base styles', () => {
        render(<Badge>Badge</Badge>)
        const badge = screen.getByText('Badge')
        expect(badge).toHaveClass('inline-flex')
        expect(badge).toHaveClass('items-center')
        expect(badge).toHaveClass('rounded-full')
        expect(badge).toHaveClass('border')
    })
})
