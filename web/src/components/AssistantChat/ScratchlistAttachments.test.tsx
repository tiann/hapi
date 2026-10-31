import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { ScratchlistAttachments } from './ScratchlistAttachments'
import { orderItemsById } from '@/lib/attachmentOrder'
import { clearScratchlistAttachmentPreviewCache, type ScratchlistAttachmentWithPreview } from '@/lib/scratchlistAttachmentPreview'

const photo: ScratchlistAttachmentWithPreview = { id: 'photo', filename: 'photo.png', mimeType: 'image/png', size: 10, path: '/photo.png', previewUrl: 'data:image/png;base64,cGhvdG8=' }
const file: ScratchlistAttachmentWithPreview = { id: 'file', filename: 'notes.txt', mimeType: 'text/plain', size: 10, path: '/notes.txt' }
const other: ScratchlistAttachmentWithPreview = { ...file, id: 'other', filename: 'other.txt' }

afterEach(() => { cleanup(); clearScratchlistAttachmentPreviewCache(); vi.restoreAllMocks() })

function Harness({ initial = [photo, file], save = async () => {} }: { initial?: ScratchlistAttachmentWithPreview[]; save?: (ids: string[]) => Promise<void> }) {
    const [attachments, setAttachments] = useState(initial)
    return <ScratchlistAttachments attachments={attachments} sessionId="test"
        onRemove={(id) => setAttachments((items) => items.filter((item) => item.id !== id))}
        onReorder={async (ids) => { await save(ids); setAttachments((items) => orderItemsById(items, ids)) }} />
}

function ids(container: HTMLElement) {
    return Array.from(container.querySelectorAll<HTMLElement>('[data-scratchlist-attachment-id]')).map((el) => el.dataset.scratchlistAttachmentId)
}

function pointer(target: EventTarget, type: string, x: number, y = 10) {
    const event = new Event(type, { bubbles: true, cancelable: true })
    Object.defineProperties(event, { button: { value: 0 }, pointerId: { value: 1 }, clientX: { value: x }, clientY: { value: y } })
    target.dispatchEvent(event)
}

describe('scratchlist attachment controls', () => {
    it.each([photo, file])('omits the reorder control for a single $filename and retains removal', (attachment) => {
        render(<Harness initial={[attachment]} />)
        expect(screen.queryByTestId('scratchlist-attachment-drag-handle')).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: `Remove attachment ${attachment.filename}` }))
        expect(screen.queryByText(attachment.filename)).not.toBeInTheDocument()
    })

    it('orders mixed image/file attachments together and hides the remaining handle after removal', async () => {
        const save = vi.fn().mockResolvedValue(undefined)
        const { container } = render(<Harness save={save} />)
        fireEvent.keyDown(screen.getByRole('button', { name: 'Reorder attachment notes.txt' }), { key: 'Home' })
        await waitFor(() => expect(ids(container)).toEqual(['file', 'photo']))
        expect(save).toHaveBeenCalledWith(['file', 'photo'])
        fireEvent.click(screen.getByRole('button', { name: 'Remove attachment notes.txt' }))
        expect(screen.queryByTestId('scratchlist-attachment-drag-handle')).not.toBeInTheDocument()
        expect(screen.getByRole('img', { name: 'photo.png' })).toBeInTheDocument()
    })

    it('commits a drag only on release and leaves the parent row untouched', async () => {
        const save = vi.fn().mockResolvedValue(undefined)
        const parentPointerDown = vi.fn()
        const { container } = render(<div onPointerDown={parentPointerDown}><Harness initial={[file, other]} save={save} /></div>)
        const target = container.querySelector('[data-scratchlist-attachment-id="other"]')!
        Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: () => [target] })
        vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({ left: 100, width: 100 } as DOMRect)
        act(() => {
            pointer(screen.getByRole('button', { name: 'Reorder attachment notes.txt' }), 'pointerdown', 10)
            pointer(document, 'pointermove', 190)
        })
        expect(ids(container)).toEqual(['other', 'file'])
        expect(save).not.toHaveBeenCalled()
        expect(parentPointerDown).not.toHaveBeenCalled()
        act(() => pointer(document, 'pointerup', 190))
        await waitFor(() => expect(save).toHaveBeenCalledExactlyOnceWith(['other', 'file']))
    })

    it('cancels an unfinished drag without saving its temporary order', () => {
        const save = vi.fn()
        const { container } = render(<Harness initial={[file, other]} save={save} />)
        const target = container.querySelector('[data-scratchlist-attachment-id="other"]')!
        Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: () => [target] })
        vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({ left: 100, width: 100 } as DOMRect)
        act(() => {
            pointer(screen.getByRole('button', { name: 'Reorder attachment notes.txt' }), 'pointerdown', 10)
            pointer(document, 'pointermove', 190)
            pointer(document, 'pointercancel', 190)
        })
        expect(ids(container)).toEqual(['file', 'other'])
        expect(save).not.toHaveBeenCalled()
    })

    it('rolls back failed saves and reports the error', async () => {
        const { container } = render(<Harness save={async () => { throw new Error('Save failed') }} />)
        fireEvent.keyDown(screen.getByRole('button', { name: 'Reorder attachment notes.txt' }), { key: 'Home' })
        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Save failed'))
        expect(ids(container)).toEqual(['photo', 'file'])
    })

    it('ignores sorting when disabled', () => {
        render(<ScratchlistAttachments attachments={[photo, file]} disabled onRemove={vi.fn()} onReorder={vi.fn()} />)
        expect(screen.queryByTestId('scratchlist-attachment-drag-handle')).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Remove attachment notes.txt' })).toBeDisabled()
    })
})
