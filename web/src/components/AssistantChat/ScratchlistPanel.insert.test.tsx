import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ScratchlistDrawer } from './ScratchlistPanel'
import { I18nProvider } from '@/lib/i18n-context'
import type { ScratchlistEntry } from '@/lib/scratchlist'
import type { ApiClient } from '@/api/client'
import {
    clearScratchlistAttachmentPreviewCache,
    getScratchlistAttachmentPreview,
    rememberScratchlistAttachmentObjectUrl,
    retainScratchlistAttachmentPreview,
} from '@/lib/scratchlistAttachmentPreview'

afterEach(() => {
    cleanup()
    clearScratchlistAttachmentPreviewCache()
    vi.restoreAllMocks()
})
const original = { id: 'original', filename: 'original.txt', mimeType: 'text/plain', size: 1, path: 'hapi-hub:scratchlist/default/test/original.txt' }
const entry: ScratchlistEntry = { id: 'draft', text: 'Existing text', createdAt: 1, attachments: [original] }

function setup(onUpdate = vi.fn().mockResolvedValue(undefined)) {
    const api = {
        uploadScratchlistAttachment: vi.fn(async (_session: string, filename: string, _content: string, mimeType: string) => ({
            success: true, attachment: { id: filename, filename, mimeType, size: 3, path: `hapi-hub:scratchlist/default/test/${filename}` },
        })),
        deleteScratchlistAttachment: vi.fn().mockResolvedValue(undefined),
    }
    const view = (entries: ScratchlistEntry[]) => <I18nProvider><ScratchlistDrawer entries={entries} sessionId="test" api={api as unknown as ApiClient}
        onUpdate={onUpdate} onReorder={vi.fn()} onDelete={vi.fn()} /></I18nProvider>
    const rendered = render(view([entry]))
    const input = screen.getByTestId('scratchlist-insert-attachments')
    const select = (files: File[]) => {
        fireEvent.click(screen.getByTestId('scratchlist-insert-attachment-plus'))
        fireEvent.change(input, { target: { files } })
    }
    return { api, onUpdate, select, rerender: (entries: ScratchlistEntry[]) => rendered.rerender(view(entries)) }
}

describe('insert attachments into a saved scratchlist draft', () => {
    it('uses the plus control instead of a duplicate menu item', () => {
        setup()
        expect(screen.getByTestId('scratchlist-insert-attachment-plus')).toHaveAccessibleName('Insert attachments')
        fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
        expect(screen.queryByRole('menuitem', { name: 'Insert attachments' })).toBeNull()
    })

    it('appends multiple selected files in selection order, preserving existing attachments and text', async () => {
        const { api, onUpdate, select } = setup()
        select([new File(['one'], 'first.txt', { type: 'text/plain' }), new File(['two'], 'second.txt', { type: 'text/plain' })])
        await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1))
        expect(api.uploadScratchlistAttachment.mock.calls.map(call => call[1])).toEqual(['first.txt', 'second.txt'])
        expect(onUpdate.mock.calls[0][0]).toBe('draft')
        expect(onUpdate.mock.calls[0][1]).toBe('Existing text')
        expect(onUpdate.mock.calls[0][2].map((a: { id: string }) => a.id)).toEqual(['original', 'first.txt', 'second.txt'])
    })

    it('seeds an image preview before delayed draft persistence completes', async () => {
        let finish!: () => void
        const pending = new Promise<void>(resolve => { finish = resolve })
        const onUpdate = vi.fn(() => pending)
        const originalCreateObjectURL = URL.createObjectURL
        const originalRevokeObjectURL = URL.revokeObjectURL
        const createObjectURL = vi.fn(() => 'blob:selected-image')
        Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
        Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })

        try {
            const { select } = setup(onUpdate)
            select([new File(['image'], 'photo.png', { type: 'image/png' })])

            await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1))
            expect(getScratchlistAttachmentPreview({
                id: 'photo.png',
                filename: 'photo.png',
                mimeType: 'image/png',
                size: 3,
                path: 'hapi-hub:scratchlist/default/test/photo.png',
            })).toBe('blob:selected-image')
            expect(onUpdate).toHaveBeenCalledTimes(1)
        } finally {
            await act(async () => finish())
            Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: originalCreateObjectURL })
            Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: originalRevokeObjectURL })
        }
    })

    it('keeps an inserted preview while the cache is over budget with retained mounted previews', async () => {
        const cachedAttachment = (id: string) => ({
            id,
            filename: `${id}.png`,
            mimeType: 'image/png',
            size: 10 * 1024 * 1024,
            path: `hapi-hub:scratchlist/default/test/${id}.png`,
        })
        const releaseCachedA = retainScratchlistAttachmentPreview('cached-a')
        const releaseCachedB = retainScratchlistAttachmentPreview('cached-b')
        rememberScratchlistAttachmentObjectUrl(cachedAttachment('cached-a'), 'blob:cached-a')
        rememberScratchlistAttachmentObjectUrl(cachedAttachment('cached-b'), 'blob:cached-b')

        let finish!: () => void
        const pending = new Promise<void>(resolve => { finish = resolve })
        const onUpdate = vi.fn(() => pending)
        const originalCreateObjectURL = URL.createObjectURL
        const originalRevokeObjectURL = URL.revokeObjectURL
        const createObjectURL = vi.fn(() => 'blob:selected-image')
        Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
        Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })

        try {
            const { select } = setup(onUpdate)
            select([new File(['image'], 'photo.png', { type: 'image/png' })])

            await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1))
            expect(getScratchlistAttachmentPreview({
                id: 'photo.png',
                filename: 'photo.png',
                mimeType: 'image/png',
                size: 3,
                path: 'hapi-hub:scratchlist/default/test/photo.png',
            })).toBe('blob:selected-image')
            expect(getScratchlistAttachmentPreview(cachedAttachment('cached-a'))).toBe('blob:cached-a')
            expect(getScratchlistAttachmentPreview(cachedAttachment('cached-b'))).toBe('blob:cached-b')
        } finally {
            await act(async () => finish())
            releaseCachedA()
            releaseCachedB()
            Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: originalCreateObjectURL })
            Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: originalRevokeObjectURL })
        }
    })

    it('does nothing when the system picker is cancelled', async () => {
        const { api, onUpdate, select } = setup()
        select([])
        await act(async () => {})
        expect(api.uploadScratchlistAttachment).not.toHaveBeenCalled()
        expect(onUpdate).not.toHaveBeenCalled()
    })

    it('cleans new uploads and keeps the original draft when persistence fails', async () => {
        const onUpdate = vi.fn().mockRejectedValue(new Error('Save unavailable'))
        const { api, select } = setup(onUpdate)
        select([new File(['data'], 'new.txt', { type: 'text/plain' })])
        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Save unavailable'))
        expect(api.deleteScratchlistAttachment).toHaveBeenCalledWith('test', 'new.txt')
        expect(screen.getByText('original.txt')).toBeInTheDocument()
        expect(screen.getByTestId('scratchlist-entry-text')).toHaveTextContent('Existing text')
    })

    it('cleans an earlier file if a later file upload fails, without partially editing the draft', async () => {
        const { api, onUpdate, select } = setup()
        api.uploadScratchlistAttachment.mockImplementationOnce(async () => ({ success: true, attachment: { ...original, id: 'created' } }))
            .mockImplementationOnce(async () => { throw new Error('Upload rejected') })
        select([new File(['one'], 'first.txt', { type: 'text/plain' }), new File(['two'], 'second.txt', { type: 'text/plain' })])
        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Upload rejected'))
        expect(api.deleteScratchlistAttachment).toHaveBeenCalledWith('test', 'created')
        expect(onUpdate).not.toHaveBeenCalled()
    })

    it('merges with the latest text and attachment order after an asynchronous upload', async () => {
        const { api, onUpdate, select, rerender } = setup()
        let finish!: () => void
        const ready = new Promise<void>(resolve => { finish = resolve })
        const upload = api.uploadScratchlistAttachment.getMockImplementation()!
        api.uploadScratchlistAttachment.mockImplementation(async (...args) => { await ready; return upload(...args) })
        select([new File(['data'], 'new.txt', { type: 'text/plain' })])
        await waitFor(() => expect(api.uploadScratchlistAttachment).toHaveBeenCalled())
        const addedElsewhere = { ...original, id: 'remote', filename: 'remote.txt' }
        rerender([{ ...entry, text: 'Edited elsewhere', attachments: [addedElsewhere, original] }])
        await act(async () => finish())
        await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1))
        expect(onUpdate.mock.calls[0][1]).toBe('Edited elsewhere')
        expect(onUpdate.mock.calls[0][2].map((a: { id: string }) => a.id)).toEqual(['remote', 'original', 'new.txt'])
    })
})
