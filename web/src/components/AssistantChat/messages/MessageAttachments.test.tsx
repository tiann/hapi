import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { AttachmentMetadata } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { MessageAttachments } from './MessageAttachments'

afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
})

const attachment: AttachmentMetadata = {
    id: 'attachment-row-1',
    filename: 'photo.png',
    mimeType: 'image/png',
    size: 2 * 1024 * 1024,
    attachmentId: 'attachment-1'
}

function renderAttachments(fetchAttachmentBlob: ApiClient['fetchAttachmentBlob']) {
    const api = { fetchAttachmentBlob } as unknown as ApiClient
    return render(
        <I18nProvider>
            <MessageAttachments attachments={[attachment]} api={api} sessionId="session-1" />
        </I18nProvider>
    )
}

describe('MessageAttachments', () => {
    it('does not eagerly fetch the original when the optional thumbnail is unavailable', async () => {
        const fetchAttachmentBlob = vi.fn().mockRejectedValue(new Error('attachment unavailable'))

        renderAttachments(fetchAttachmentBlob)

        expect(screen.getByText('Loading preview…')).toBeInTheDocument()
        await waitFor(() => expect(fetchAttachmentBlob).toHaveBeenCalledTimes(1))
        expect(fetchAttachmentBlob).toHaveBeenCalledWith('session-1', 'attachment-1', 'thumbnail')
        expect(screen.getByText('photo.png')).toBeInTheDocument()
        expect(screen.getByText('2.0 MB')).toBeInTheDocument()
        expect(screen.queryByText('Loading preview…')).not.toBeInTheDocument()
    })

    it('loads the original only after an explicit action when the thumbnail is unavailable', async () => {
        const fetchAttachmentBlob = vi.fn()
            .mockRejectedValueOnce(new Error('thumbnail unavailable'))
            .mockResolvedValueOnce(new Blob(['original'], { type: 'image/png' }))
        vi.stubGlobal('URL', {
            createObjectURL: vi.fn(() => 'blob:original'),
            revokeObjectURL: vi.fn()
        })

        renderAttachments(fetchAttachmentBlob)

        await waitFor(() => expect(fetchAttachmentBlob).toHaveBeenCalledTimes(1))
        const loadButton = screen.getByRole('button', { name: /Load original/ })
        fireEvent.click(loadButton)

        await waitFor(() => expect(fetchAttachmentBlob).toHaveBeenCalledTimes(2))
        expect(fetchAttachmentBlob).toHaveBeenNthCalledWith(2, 'session-1', 'attachment-1', 'original')
    })

    it('does not create an original object URL after unmount while loading', async () => {
        let resolveOriginal!: (blob: Blob) => void
        const originalPromise = new Promise<Blob>(resolve => {
            resolveOriginal = resolve
        })
        const createObjectURL = vi.fn(() => 'blob:original')
        const revokeObjectURL = vi.fn()
        const fetchAttachmentBlob = vi.fn()
            .mockRejectedValueOnce(new Error('thumbnail unavailable'))
            .mockReturnValueOnce(originalPromise)
        vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })

        const view = renderAttachments(fetchAttachmentBlob)

        await waitFor(() => expect(fetchAttachmentBlob).toHaveBeenCalledTimes(1))
        fireEvent.click(screen.getByRole('button', { name: /Load original/ }))
        await waitFor(() => expect(fetchAttachmentBlob).toHaveBeenCalledTimes(2))

        view.unmount()
        resolveOriginal(new Blob(['original'], { type: 'image/png' }))

        await waitFor(() => expect(createObjectURL).not.toHaveBeenCalled())
    })
})
