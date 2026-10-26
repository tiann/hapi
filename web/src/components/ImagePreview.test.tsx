import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ImagePreview } from './ImagePreview'

function renderGallery() {
    render(
        <>
            <ImagePreview src="/first.png" fileName="first.png" label="First image" />
            <ImagePreview src="/second.png" fileName="second.png" label="Second image" />
        </>
    )
}

describe('ImagePreview gallery navigation', () => {
    it.each(['mouse', 'touch', 'pen'])('keeps %s preview gestures out of the surrounding attachment drag handler', (pointerType) => {
        const onAttachmentPointerDown = vi.fn()
        render(
            <div onPointerDown={onAttachmentPointerDown}>
                <ImagePreview src="/photo.png" fileName="photo.png" label="Photo" />
            </div>
        )
        fireEvent.click(screen.getByTitle('Click to zoom'))
        const dialog = screen.getByRole('dialog')
        const image = within(dialog).getByRole('img', { name: 'Photo' })
        const canvas = image.parentElement!
        const setPointerCapture = vi.fn()
        Object.defineProperty(canvas, 'setPointerCapture', { value: setPointerCapture, configurable: true })
        const pointer = (type: string, x: number, y: number, buttons: number) => {
            const event = new Event(type, { bubbles: true, cancelable: true })
            Object.defineProperties(event, {
                pointerId: { value: 1 }, pointerType: { value: pointerType },
                button: { value: 0 }, buttons: { value: buttons },
                clientX: { value: x }, clientY: { value: y },
            })
            fireEvent(image, event)
        }

        pointer('pointerdown', 100, 100, 1)
        expect(setPointerCapture).toHaveBeenCalledWith(1)
        expect(onAttachmentPointerDown).not.toHaveBeenCalled()
        pointer('pointermove', 140, 120, 1)
        expect(image.style.transform).toContain('40px')
        pointer('pointerup', 140, 120, 0)
        const releasedTransform = image.style.transform
        pointer('pointermove', 180, 160, 0)
        expect(image.style.transform).toBe(releasedTransform)

        pointer('pointerdown', 180, 160, 1)
        pointer('pointermove', 200, 180, 1)
        pointer('pointercancel', 200, 180, 0)
        const cancelledTransform = image.style.transform
        pointer('pointermove', 240, 220, 0)
        expect(image.style.transform).toBe(cancelledTransform)

        fireEvent.pointerDown(within(dialog).getByTitle('Zoom in'))
        expect(onAttachmentPointerDown).not.toHaveBeenCalled()
        fireEvent.click(within(dialog).getByTitle('Zoom in'))
        expect(within(dialog).getByTitle('Reset zoom')).toHaveTextContent('125%')
    })

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

    it('exposes trigger pointer and context-menu hooks for sortable image attachments', () => {
        const onTriggerPointerDown = vi.fn()
        const onTriggerContextMenu = vi.fn()
        const onTriggerClick = vi.fn()

        render(
            <ImagePreview
                src="/drag.png"
                fileName="drag.png"
                label="Drag image"
                onTriggerPointerDown={onTriggerPointerDown}
                onTriggerContextMenu={onTriggerContextMenu}
                onTriggerClick={onTriggerClick}
            />
        )

        const trigger = screen.getByRole('button', { name: /drag image/i })
        fireEvent.pointerDown(trigger)
        fireEvent.contextMenu(trigger)
        fireEvent.click(trigger)

        expect(onTriggerPointerDown).toHaveBeenCalledTimes(1)
        expect(onTriggerContextMenu).toHaveBeenCalledTimes(1)
        expect(onTriggerClick).toHaveBeenCalledTimes(1)
        expect(screen.getByRole('dialog', { name: 'Drag image' })).toBeInTheDocument()
    })
})
