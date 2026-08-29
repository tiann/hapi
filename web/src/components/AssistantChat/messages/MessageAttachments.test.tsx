import { cleanup, render, screen, waitFor } from '@testing-library/react'
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

function renderAttachments(
    fetchAttachmentBlob: ApiClient['fetchAttachmentBlob'],
    value: AttachmentMetadata = attachment
) {
    const api = { fetchAttachmentBlob } as unknown as ApiClient
    return render(
        <I18nProvider>
            <MessageAttachments attachments={[value]} api={api} sessionId="session-1" />
        </I18nProvider>
    )
}

describe('MessageAttachments', () => {
    it('loads a durable original while rendering the message card', async () => {
        const fetchAttachmentBlob = vi.fn().mockResolvedValue(new Blob(['original'], { type: 'image/png' }))
        vi.stubGlobal('URL', {
            createObjectURL: vi.fn(() => 'blob:original'),
            revokeObjectURL: vi.fn()
        })

        renderAttachments(fetchAttachmentBlob)

        expect(screen.getByText('Loading…')).toBeInTheDocument()
        await waitFor(() => expect(screen.getByRole('img', { name: 'photo.png' })).toHaveAttribute('src', 'blob:original'))
        expect(fetchAttachmentBlob).toHaveBeenCalledWith('session-1', 'attachment-1')
    })

    it('uses a legacy preview without fetching a durable original', () => {
        const fetchAttachmentBlob = vi.fn()
        renderAttachments(fetchAttachmentBlob, {
            ...attachment,
            attachmentId: undefined,
            previewUrl: 'data:image/png;base64,cGhvdG8='
        })

        expect(fetchAttachmentBlob).not.toHaveBeenCalled()
        expect(screen.getByRole('img', { name: 'photo.png' })).toHaveAttribute(
            'src',
            'data:image/png;base64,cGhvdG8='
        )
    })

    it('keeps the attachment card when the original cannot be loaded', async () => {
        const fetchAttachmentBlob = vi.fn().mockRejectedValue(new Error('attachment unavailable'))
        renderAttachments(fetchAttachmentBlob)

        await waitFor(() => expect(screen.getByText('photo.png')).toBeInTheDocument())
        expect(screen.getByRole('button', { name: /photo\.png/i })).toBeInTheDocument()
        expect(screen.getByText('Download file')).toBeInTheDocument()
    })

    it('does not create an object URL after unmount while loading', async () => {
        let resolveOriginal!: (blob: Blob) => void
        const originalPromise = new Promise<Blob>(resolve => {
            resolveOriginal = resolve
        })
        const createObjectURL = vi.fn(() => 'blob:original')
        vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() })

        const view = renderAttachments(vi.fn().mockReturnValue(originalPromise))
        await waitFor(() => expect(screen.getByText('Loading…')).toBeInTheDocument())

        view.unmount()
        resolveOriginal(new Blob(['original'], { type: 'image/png' }))

        await waitFor(() => expect(createObjectURL).not.toHaveBeenCalled())
    })
})
