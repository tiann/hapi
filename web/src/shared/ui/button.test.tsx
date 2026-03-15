import { describe, expect, it, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { Button } from './button'

describe('Button', () => {
    afterEach(() => {
        cleanup()
    })

    it('renders button with text', () => {
        const { getByRole } = render(<Button>Click me</Button>)
        expect(getByRole('button', { name: 'Click me' })).toBeInTheDocument()
    })

    it('applies default variant', () => {
        const { getByRole } = render(<Button>Default</Button>)
        const button = getByRole('button')
        expect(button).toHaveClass('bg-[var(--app-button)]')
    })

    it('applies secondary variant', () => {
        const { getByRole } = render(<Button variant="secondary">Secondary</Button>)
        const button = getByRole('button')
        expect(button).toHaveClass('bg-[var(--app-secondary-bg)]')
    })

    it('applies outline variant', () => {
        const { getByRole } = render(<Button variant="outline">Outline</Button>)
        const button = getByRole('button')
        expect(button).toHaveClass('border')
    })

    it('applies destructive variant', () => {
        const { getByRole } = render(<Button variant="destructive">Delete</Button>)
        const button = getByRole('button')
        expect(button).toHaveClass('bg-[var(--app-badge-error-bg)]')
    })

    it('applies default size', () => {
        const { getByRole } = render(<Button>Default size</Button>)
        const button = getByRole('button')
        expect(button).toHaveClass('h-9')
    })

    it('applies small size', () => {
        const { getByRole } = render(<Button size="sm">Small</Button>)
        const button = getByRole('button')
        expect(button).toHaveClass('h-8')
    })

    it('applies large size', () => {
        const { getByRole } = render(<Button size="lg">Large</Button>)
        const button = getByRole('button')
        expect(button).toHaveClass('h-10')
    })

    it('handles disabled state', () => {
        const { getByRole } = render(<Button disabled>Disabled</Button>)
        const button = getByRole('button')
        expect(button).toBeDisabled()
        expect(button).toHaveClass('disabled:opacity-50')
    })

    it('accepts custom className', () => {
        const { getByRole } = render(<Button className="custom-class">Custom</Button>)
        const button = getByRole('button')
        expect(button).toHaveClass('custom-class')
    })

    it('forwards ref', () => {
        const ref = { current: null }
        render(<Button ref={ref}>With ref</Button>)
        expect(ref.current).toBeInstanceOf(HTMLButtonElement)
    })

    it('renders as child when asChild is true', () => {
        render(
            <Button asChild>
                <a href="/test">Link button</a>
            </Button>
        )
        const link = screen.getByRole('link')
        expect(link).toHaveAttribute('href', '/test')
    })

    it('passes through HTML button attributes', () => {
        const { getByRole } = render(
            <Button type="submit" name="submit-btn">
                Submit
            </Button>
        )
        const button = getByRole('button')
        expect(button).toHaveAttribute('type', 'submit')
        expect(button).toHaveAttribute('name', 'submit-btn')
    })
})
