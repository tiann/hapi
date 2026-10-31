import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ScratchlistDrawer } from './ScratchlistPanel'
import { I18nProvider } from '@/lib/i18n-context'
import type { ScratchlistEntry } from '@/lib/scratchlist'
import type { ApiClient } from '@/api/client'

afterEach(cleanup)
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
        fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
        fireEvent.click(screen.getByRole('menuitem', { name: 'Insert attachments' }))
        fireEvent.change(input, { target: { files } })
    }
    return { api, onUpdate, select, rerender: (entries: ScratchlistEntry[]) => rendered.rerender(view(entries)) }
}

describe('insert attachments into a saved scratchlist draft', () => {
    it('appends multiple selected files in selection order, preserving existing attachments and text', async () => {
        const { api, onUpdate, select } = setup()
        select([new File(['one'], 'first.txt', { type: 'text/plain' }), new File(['two'], 'second.txt', { type: 'text/plain' })])
        await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1))
        expect(api.uploadScratchlistAttachment.mock.calls.map(call => call[1])).toEqual(['first.txt', 'second.txt'])
        expect(onUpdate.mock.calls[0][0]).toBe('draft')
        expect(onUpdate.mock.calls[0][1]).toBe('Existing text')
        expect(onUpdate.mock.calls[0][2].map((a: { id: string }) => a.id)).toEqual(['original', 'first.txt', 'second.txt'])
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
