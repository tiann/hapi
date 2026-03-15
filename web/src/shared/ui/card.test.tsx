import { describe, expect, it, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from './card'

describe('Card', () => {
    afterEach(() => {
        cleanup()
    })
    it('renders card with content', () => {
        render(<Card>Card content</Card>)
        expect(screen.getByText('Card content')).toBeInTheDocument()
    })

    it('applies base styles', () => {
        const { container } = render(<Card>Content</Card>)
        const card = container.firstChild as HTMLElement
        expect(card).toHaveClass('rounded-lg')
        expect(card).toHaveClass('bg-[var(--app-secondary-bg)]')
        expect(card).toHaveClass('shadow-sm')
    })

    it('accepts custom className', () => {
        const { container } = render(<Card className="custom-class">Content</Card>)
        const card = container.firstChild as HTMLElement
        expect(card).toHaveClass('custom-class')
    })

    it('forwards ref', () => {
        const ref = { current: null }
        render(<Card ref={ref}>Content</Card>)
        expect(ref.current).toBeInstanceOf(HTMLDivElement)
    })
})

describe('CardHeader', () => {
    it('renders header with content', () => {
        render(<CardHeader>Header content</CardHeader>)
        expect(screen.getByText('Header content')).toBeInTheDocument()
    })

    it('applies base styles', () => {
        const { container } = render(<CardHeader>Header</CardHeader>)
        const header = container.firstChild as HTMLElement
        expect(header).toHaveClass('flex')
        expect(header).toHaveClass('flex-col')
        expect(header).toHaveClass('p-4')
    })

    it('forwards ref', () => {
        const ref = { current: null }
        render(<CardHeader ref={ref}>Header</CardHeader>)
        expect(ref.current).toBeInstanceOf(HTMLDivElement)
    })
})

describe('CardTitle', () => {
    it('renders title with content', () => {
        render(<CardTitle>Card Title</CardTitle>)
        expect(screen.getByText('Card Title')).toBeInTheDocument()
    })

    it('renders as h3 element', () => {
        const { container } = render(<CardTitle>Title</CardTitle>)
        expect(container.querySelector('h3')).toBeInTheDocument()
    })

    it('applies base styles', () => {
        const { container } = render(<CardTitle>Title</CardTitle>)
        const title = container.firstChild as HTMLElement
        expect(title).toHaveClass('text-base')
        expect(title).toHaveClass('font-semibold')
    })

    it('forwards ref', () => {
        const ref = { current: null }
        render(<CardTitle ref={ref}>Title</CardTitle>)
        expect(ref.current).toBeInstanceOf(HTMLHeadingElement)
    })
})

describe('CardDescription', () => {
    it('renders description with content', () => {
        render(<CardDescription>Card description</CardDescription>)
        expect(screen.getByText('Card description')).toBeInTheDocument()
    })

    it('renders as p element', () => {
        const { container } = render(<CardDescription>Description</CardDescription>)
        expect(container.querySelector('p')).toBeInTheDocument()
    })

    it('applies base styles', () => {
        const { container } = render(<CardDescription>Description</CardDescription>)
        const description = container.firstChild as HTMLElement
        expect(description).toHaveClass('text-sm')
        expect(description).toHaveClass('text-[var(--app-hint)]')
    })

    it('forwards ref', () => {
        const ref = { current: null }
        render(<CardDescription ref={ref}>Description</CardDescription>)
        expect(ref.current).toBeInstanceOf(HTMLParagraphElement)
    })
})

describe('CardContent', () => {
    it('renders content', () => {
        render(<CardContent>Content text</CardContent>)
        expect(screen.getByText('Content text')).toBeInTheDocument()
    })

    it('applies base styles', () => {
        const { container } = render(<CardContent>Content</CardContent>)
        const content = container.firstChild as HTMLElement
        expect(content).toHaveClass('p-4')
        expect(content).toHaveClass('pt-0')
    })

    it('forwards ref', () => {
        const ref = { current: null }
        render(<CardContent ref={ref}>Content</CardContent>)
        expect(ref.current).toBeInstanceOf(HTMLDivElement)
    })
})

describe('Card composition', () => {
    it('renders complete card structure', () => {
        const { getByText } = render(
            <Card>
                <CardHeader>
                    <CardTitle>Card Title Text</CardTitle>
                    <CardDescription>Card Description Text</CardDescription>
                </CardHeader>
                <CardContent>Card Content Text</CardContent>
            </Card>
        )

        expect(getByText('Card Title Text')).toBeInTheDocument()
        expect(getByText('Card Description Text')).toBeInTheDocument()
        expect(getByText('Card Content Text')).toBeInTheDocument()
    })
})
