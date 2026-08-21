import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ImagePreview } from './ImagePreview'

function renderGallery() {
    render(
        <>
            <ImagePreview src="/first.png" fileName="first.png" label="First image" fileSize={1536} />
            <ImagePreview src="/second.png" fileName="second.png" label="Second image" fileSize={2048} />
        </>
    )
}

describe('ImagePreview gallery navigation', () => {
    it('navigates between rendered image previews with toolbar buttons', () => {
        renderGallery()

        fireEvent.click(screen.getByRole('button', { name: /first image/i }))

        const dialog = screen.getByRole('dialog', { name: 'First image' })
        expect(within(dialog).getAllByRole('button').map((button) => button.getAttribute('title'))).toEqual([
            'Close',
            'Zoom out',
            'Reset zoom',
            'Zoom in',
            'Previous image',
            'Next image',
        ])
        expect(within(dialog).getAllByRole('button')
            .map((button) => button.querySelector('svg')?.getAttribute('class'))
            .filter(Boolean)).toEqual([
            'h-4 w-4',
            'h-4 w-4',
            'h-4 w-4',
            'h-4 w-4',
            'h-4 w-4',
        ])
        expect(within(dialog).getByRole('button', { name: '100%' })).toHaveClass(
            'flex',
            'h-8',
            'items-center',
            'justify-center',
        )
        const image = within(dialog).getByRole('img', { name: 'First image' })
        Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 1200 })
        Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 700 })
        fireEvent.load(image)
        const desktopInfo = dialog.querySelector('[data-image-preview-info="desktop"]')
        expect(desktopInfo).not.toBeNull()
        expect(desktopInfo).toHaveClass('flex', 'flex-1', 'items-center', 'max-sm:hidden')
        expect(desktopInfo).toHaveTextContent('first.png')
        const mobileInfo = dialog.querySelector('[data-image-preview-info="mobile"]')
        expect(mobileInfo).not.toBeNull()
        expect(mobileInfo).toHaveClass('hidden', 'max-sm:flex', 'border-t')
        const imageMetadata = within(desktopInfo as HTMLElement).getByText('1200 × 700 px · 1.5 KB')
        expect(imageMetadata).toBeInTheDocument()
        expect(imageMetadata).toHaveClass('shrink-0', 'text-sm', 'text-white/60')
        expect(imageMetadata.parentElement).toHaveClass('items-center', 'text-sm')
        expect(imageMetadata.parentElement).toHaveAttribute('data-image-preview-info', 'desktop')
        expect(dialog).toHaveClass('fixed', 'inset-0', 'flex-col')
        expect(within(dialog).getByRole('button', { name: 'Zoom out' }).parentElement).toHaveAttribute('data-image-preview-controls', '')
        expect(within(dialog).getByRole('button', { name: 'Zoom out' }).parentElement).toHaveClass('max-sm:order-2', 'max-sm:gap-1')
        expect(within(dialog).getByText('1 / 2')).toBeInTheDocument()
        expect(within(dialog).getByRole('button', { name: 'Previous image' })).toBeDisabled()

        fireEvent.click(within(dialog).getByRole('button', { name: 'Next image' }))

        const nextDialog = screen.getByRole('dialog', { name: 'Second image' })
        const nextDesktopInfo = nextDialog.querySelector('[data-image-preview-info="desktop"]')
        expect(nextDesktopInfo).not.toBeNull()
        expect(nextDesktopInfo).toHaveTextContent('second.png')
        expect(nextDesktopInfo).toHaveTextContent('2 KB')
        expect(within(nextDialog).getByText('2 / 2')).toBeInTheDocument()
        expect(within(nextDialog).getByRole('img', { name: 'Second image' })).toHaveAttribute('src', '/second.png')
        expect(within(nextDialog).getByRole('button', { name: 'Next image' })).toBeDisabled()
    })

    it('supports left and right arrow keys', () => {
        renderGallery()

        fireEvent.click(screen.getByRole('button', { name: /first image/i }))
        fireEvent.keyDown(window, { key: 'ArrowRight' })
        expect(screen.getByRole('dialog', { name: 'Second image' })).toBeInTheDocument()

        fireEvent.keyDown(window, { key: 'ArrowLeft' })
        expect(screen.getByRole('dialog', { name: 'First image' })).toBeInTheDocument()
    })

    it('keeps named galleries separate from ungrouped previews', () => {
        render(
            <>
                <ImagePreview src="/sent.png" fileName="sent.png" label="Sent image" />
                <ImagePreview src="/draft-one.png" fileName="draft-one.png" label="First draft" galleryId="composer-attachments" />
                <ImagePreview src="/draft-two.png" fileName="draft-two.png" label="Second draft" galleryId="composer-attachments" />
            </>
        )

        fireEvent.click(screen.getByRole('button', { name: /first draft/i }))

        const dialog = screen.getByRole('dialog', { name: 'First draft' })
        expect(within(dialog).getByText('1 / 2')).toBeInTheDocument()
        fireEvent.click(within(dialog).getByRole('button', { name: 'Next image' }))
        expect(screen.getByRole('dialog', { name: 'Second draft' })).toBeInTheDocument()
        expect(within(screen.getByRole('dialog')).queryByRole('img', { name: 'Sent image' })).not.toBeInTheDocument()
    })
})
