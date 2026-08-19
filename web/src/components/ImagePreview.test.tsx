import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { I18nProvider } from '@/lib/i18n-context'
import type { Locale } from '@/lib/use-translation'
import { ImagePreview } from './ImagePreview'

function renderWithLocale(ui: ReactNode, locale: Locale = 'en') {
    window.localStorage.setItem('hapi-lang', locale)
    return render(<I18nProvider>{ui}</I18nProvider>)
}

function renderGallery() {
    renderWithLocale(
        <>
            <ImagePreview src="/first.png" fileName="first.png" label="First image" />
            <ImagePreview src="/second.png" fileName="second.png" label="Second image" />
        </>
    )
}

describe('ImagePreview gallery navigation', () => {
    it('navigates between rendered image previews with toolbar buttons', () => {
        renderGallery()

        fireEvent.click(screen.getByRole('button', { name: /first image/i }))

        const dialog = screen.getByRole('dialog', { name: 'First image' })
        expect(within(dialog).getByText('1 / 2')).toBeInTheDocument()
        expect(within(dialog).getByRole('button', { name: 'Previous image' })).toBeDisabled()

        fireEvent.click(within(dialog).getByRole('button', { name: 'Next image' }))

        const nextDialog = screen.getByRole('dialog', { name: 'Second image' })
        expect(within(nextDialog).getByText('second.png')).toBeInTheDocument()
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
        renderWithLocale(
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

    it('shows an original-image loading status until the deferred source resolves', async () => {
        let resolveOriginal: (source: string) => void = () => {}
        const onOpen = vi.fn(() => new Promise<string>((resolve) => {
            resolveOriginal = resolve
        }))

        renderWithLocale(
            <ImagePreview
                src="/thumbnail.png"
                fileName="photo.jpg"
                label="Photo"
                onOpen={onOpen}
            />
        )

        fireEvent.click(screen.getByRole('button', { name: /photo/i }))

        const dialog = screen.getByRole('dialog', { name: 'Photo' })
        expect(onOpen).toHaveBeenCalledOnce()
        const loadingStatus = within(dialog).getByRole('status')
        expect(loadingStatus).toHaveTextContent('Loading original…')
        expect(loadingStatus).toHaveClass('bottom-4', 'justify-start')
        const image = within(dialog).getByRole('img', { name: 'Photo' })
        expect(image).toHaveAttribute('src', '/thumbnail.png')
        expect(image).not.toHaveClass('opacity-60')

        resolveOriginal('/original.jpg')

        await waitFor(() => {
            expect(within(dialog).getByRole('img', { name: 'Photo' })).toHaveAttribute('src', '/original.jpg')
        })
        expect(within(dialog).queryByText('Loading original…')).not.toBeInTheDocument()
    })

    it('keeps the thumbnail and retries after the original source fails', async () => {
        const sources: Array<string | undefined> = [undefined, '/original.jpg']
        const onOpen = vi.fn(async () => sources.shift())

        renderWithLocale(
            <ImagePreview
                src="/thumbnail.png"
                fileName="photo.jpg"
                label="Photo"
                onOpen={onOpen}
            />
        )

        fireEvent.click(screen.getByRole('button', { name: /photo/i }))

        const dialog = screen.getByRole('dialog', { name: 'Photo' })
        await waitFor(() => {
            expect(within(dialog).getByRole('status')).toHaveTextContent('Original image unavailable')
        })
        expect(within(dialog).getByRole('img', { name: 'Photo' })).toHaveAttribute('src', '/thumbnail.png')

        fireEvent.click(within(dialog).getByRole('button', { name: 'Retry loading original' }))

        await waitFor(() => {
            expect(onOpen).toHaveBeenCalledTimes(2)
            expect(within(dialog).getByRole('img', { name: 'Photo' })).toHaveAttribute('src', '/original.jpg')
        })
        expect(within(dialog).queryByText('Original image unavailable')).not.toBeInTheDocument()
    })

    it('retries the active gallery image with its own original loader', async () => {
        const firstOnOpen = vi.fn(async () => undefined)
        const secondSources: Array<string | undefined> = [undefined, '/second-original.jpg']
        const secondOnOpen = vi.fn(async () => secondSources.shift())

        renderWithLocale(
            <>
                <ImagePreview
                    src="/first-thumbnail.png"
                    fileName="first.jpg"
                    label="First image"
                    galleryId="photos"
                    onOpen={firstOnOpen}
                />
                <ImagePreview
                    src="/second-thumbnail.png"
                    fileName="second.jpg"
                    label="Second image"
                    galleryId="photos"
                    onOpen={secondOnOpen}
                />
            </>
        )

        fireEvent.click(screen.getByRole('button', { name: /first image/i }))
        const dialog = screen.getByRole('dialog', { name: 'First image' })
        await waitFor(() => {
            expect(within(dialog).getByRole('status')).toHaveTextContent('Original image unavailable')
        })

        fireEvent.click(within(dialog).getByRole('button', { name: 'Next image' }))
        expect(within(dialog).getByRole('img', { name: 'Second image' })).toHaveAttribute('src', '/second-thumbnail.png')
        await waitFor(() => {
            expect(within(dialog).getByRole('status')).toHaveTextContent('Original image unavailable')
        })
        fireEvent.click(within(dialog).getByRole('button', { name: 'Retry loading original' }))

        await waitFor(() => {
            expect(secondOnOpen).toHaveBeenCalledTimes(2)
            expect(within(dialog).getByRole('img', { name: 'Second image' })).toHaveAttribute('src', '/second-original.jpg')
        })
        expect(firstOnOpen).toHaveBeenCalledOnce()
    })

    it('loads the original for the newly active gallery image', async () => {
        const firstOnOpen = vi.fn(async () => '/first-original.jpg')
        const secondOnOpen = vi.fn(async () => '/second-original.jpg')

        renderWithLocale(
            <>
                <ImagePreview
                    src="/first-thumbnail.png"
                    fileName="first.jpg"
                    label="First image"
                    galleryId="photos"
                    onOpen={firstOnOpen}
                />
                <ImagePreview
                    src="/second-thumbnail.png"
                    fileName="second.jpg"
                    label="Second image"
                    galleryId="photos"
                    onOpen={secondOnOpen}
                />
            </>
        )

        fireEvent.click(screen.getByRole('button', { name: /first image/i }))
        const dialog = screen.getByRole('dialog', { name: 'First image' })
        await waitFor(() => {
            expect(within(dialog).getByRole('img', { name: 'First image' })).toHaveAttribute('src', '/first-original.jpg')
        })

        fireEvent.click(within(dialog).getByRole('button', { name: 'Next image' }))
        await waitFor(() => {
            expect(secondOnOpen).toHaveBeenCalledOnce()
            expect(within(dialog).getByRole('img', { name: 'Second image' })).toHaveAttribute('src', '/second-original.jpg')
        })
    })

    it('localizes original-image status and retry labels for Chinese UI', async () => {
        const onOpen = vi.fn(async () => undefined)

        renderWithLocale(
            <ImagePreview
                src="/thumbnail.png"
                fileName="photo.jpg"
                label="Photo"
                onOpen={onOpen}
            />,
            'zh-CN'
        )

        fireEvent.click(screen.getByRole('button', { name: /photo/i }))

        const dialog = screen.getByRole('dialog', { name: 'Photo' })
        await waitFor(() => {
            expect(within(dialog).getByRole('status')).toHaveTextContent('原图加载失败')
        })
        expect(within(dialog).queryByText('Original image unavailable')).not.toBeInTheDocument()
        expect(within(dialog).getByRole('button', { name: '重试加载原图' })).toBeInTheDocument()
    })
})
