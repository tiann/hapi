import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ChatImage } from './ChatImage'

afterEach(() => {
    cleanup()
})

function getInlineImage(container: HTMLElement): HTMLImageElement {
    const image = container.querySelector('button img')
    if (!image) {
        throw new Error('Inline image not found')
    }
    return image as HTMLImageElement
}

describe('ChatImage', () => {
    it('renders image with src/alt and lazy loading attributes', () => {
        const { container } = render(<ChatImage src="https://example.com/image.png" alt="Test image" />)
        const image = getInlineImage(container)

        fireEvent.load(image)

        expect(image).toHaveAttribute('src', 'https://example.com/image.png')
        expect(image).toHaveAttribute('alt', 'Test image')
        expect(image).toHaveAttribute('loading', 'lazy')
        expect(image).toHaveAttribute('decoding', 'async')
    })

    it('opens full-size modal on click and closes with escape', async () => {
        const { container } = render(<ChatImage src="https://example.com/image.png" alt="Preview image" />)
        const image = getInlineImage(container)
        fireEvent.load(image)

        fireEvent.click(screen.getByRole('button', { name: 'View full size image' }))

        const dialog = await screen.findByRole('dialog')
        const modalImage = within(dialog).getByRole('img', { name: 'Preview image' })
        expect(modalImage).toHaveAttribute('src', 'https://example.com/image.png')

        fireEvent.keyDown(document, { key: 'Escape' })
        await waitFor(() => {
            expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        })
    })

    it('closes modal via close button', async () => {
        const { container } = render(<ChatImage src="https://example.com/image.png" alt="Zoomable image" />)
        const image = getInlineImage(container)
        fireEvent.load(image)

        fireEvent.click(screen.getByRole('button', { name: 'View full size image' }))

        const dialog = await screen.findByRole('dialog')
        fireEvent.click(within(dialog).getByRole('button', { name: 'Close image preview' }))

        await waitFor(() => {
            expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        })
    })

    it('shows a loading skeleton before image load', () => {
        render(<ChatImage src="https://example.com/image.png" alt="Skeleton image" />)
        expect(screen.getByTestId('chat-image-skeleton')).toBeInTheDocument()
    })

    it('shows error fallback when image fails to load', () => {
        const { container } = render(<ChatImage src="https://example.com/broken.png" alt="Broken image" />)
        const image = getInlineImage(container)

        fireEvent.error(image)

        expect(screen.getByText('Image failed to load')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'View full size image' })).toBeDisabled()
    })

    it('uses subtle background and keyboard-focusable trigger button', () => {
        render(<ChatImage src="https://example.com/image.png" alt="Focusable image" />)
        const button = screen.getByRole('button', { name: 'View full size image' })

        expect(button.className).toContain('bg-[var(--app-subtle-bg)]')
        button.focus()
        expect(button).toHaveFocus()
    })
})
