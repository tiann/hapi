import { describe, expect, it, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import {
    Dialog,
    DialogTrigger,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
} from './dialog'

describe('Dialog', () => {
    afterEach(() => {
        cleanup()
    })
    it('renders dialog with trigger and content', () => {
        render(
            <Dialog open={true}>
                <DialogTrigger>Open</DialogTrigger>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Dialog Title</DialogTitle>
                        <DialogDescription>Dialog description</DialogDescription>
                    </DialogHeader>
                </DialogContent>
            </Dialog>
        )

        expect(screen.getByText('Dialog Title')).toBeInTheDocument()
        expect(screen.getByText('Dialog description')).toBeInTheDocument()
    })

    it('does not render content when closed', () => {
        render(
            <Dialog open={false}>
                <DialogTrigger>Open</DialogTrigger>
                <DialogContent>
                    <DialogTitle>Hidden Title</DialogTitle>
                </DialogContent>
            </Dialog>
        )

        expect(screen.queryByText('Hidden Title')).not.toBeInTheDocument()
    })
})

describe('DialogContent', () => {
    it('renders content with children', () => {
        const { getByText } = render(
            <Dialog open={true}>
                <DialogContent>
                    <DialogTitle>Title</DialogTitle>
                    Content text
                </DialogContent>
            </Dialog>
        )

        expect(getByText('Content text')).toBeInTheDocument()
    })
})

describe('DialogHeader', () => {
    it('renders header with children', () => {
        const { getByText } = render(
            <Dialog open={true}>
                <DialogContent>
                    <DialogTitle>Title</DialogTitle>
                    <DialogHeader>Header content</DialogHeader>
                </DialogContent>
            </Dialog>
        )

        expect(getByText('Header content')).toBeInTheDocument()
    })
})

describe('DialogTitle', () => {
    it('renders title with text', () => {
        const { getByText } = render(
            <Dialog open={true}>
                <DialogContent>
                    <DialogTitle>Unique Title Text</DialogTitle>
                </DialogContent>
            </Dialog>
        )

        expect(getByText('Unique Title Text')).toBeInTheDocument()
    })

    it('applies base styles', () => {
        const { getByText } = render(
            <Dialog open={true}>
                <DialogContent>
                    <DialogTitle>Styled Title</DialogTitle>
                </DialogContent>
            </Dialog>
        )

        const title = getByText('Styled Title')
        expect(title).toHaveClass('text-base')
        expect(title).toHaveClass('font-semibold')
    })
})

describe('DialogDescription', () => {
    it('renders description with text', () => {
        const { getByText } = render(
            <Dialog open={true}>
                <DialogContent>
                    <DialogTitle>Title</DialogTitle>
                    <DialogDescription>Description text</DialogDescription>
                </DialogContent>
            </Dialog>
        )

        expect(getByText('Description text')).toBeInTheDocument()
    })

    it('applies base styles', () => {
        const { getByText } = render(
            <Dialog open={true}>
                <DialogContent>
                    <DialogTitle>Title</DialogTitle>
                    <DialogDescription>Description</DialogDescription>
                </DialogContent>
            </Dialog>
        )

        const description = getByText('Description')
        expect(description).toHaveClass('text-sm')
        expect(description).toHaveClass('text-[var(--app-hint)]')
    })
})

describe('Dialog composition', () => {
    it('renders complete dialog structure', () => {
        render(
            <Dialog open={true}>
                <DialogTrigger>Open Dialog</DialogTrigger>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Complete Dialog</DialogTitle>
                        <DialogDescription>This is a complete dialog example</DialogDescription>
                    </DialogHeader>
                    <div>Dialog body content</div>
                </DialogContent>
            </Dialog>
        )

        expect(screen.getByText('Complete Dialog')).toBeInTheDocument()
        expect(screen.getByText('This is a complete dialog example')).toBeInTheDocument()
        expect(screen.getByText('Dialog body content')).toBeInTheDocument()
    })
})
