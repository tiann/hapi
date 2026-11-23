import { describe, expect, it, vi } from 'vitest'
import { createAttachmentAdapter } from './attachmentAdapter'
import { createScratchlistAttachmentAdapter } from './scratchlistAttachmentAdapter'

function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (error: Error) => void
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
    return { promise, resolve, reject }
}

describe.each(['chat', 'scratchlist', 'scratchlist-chat-path'] as const)('%s attachment removal', (mode) => {
    function setup() {
        const cleanup = deferred<void>()
        const deleteUploadFile = vi.fn(() => cleanup.promise)
        const deleteScratchlistAttachment = vi.fn(() => cleanup.promise)
        const api = { deleteUploadFile, deleteScratchlistAttachment } as never
        const adapter = mode === 'chat'
            ? createAttachmentAdapter(api, 'current-session')
            : createScratchlistAttachmentAdapter(api, 'current-session')
        const attachment = {
            id: 'a', type: 'file', name: 'A.png', contentType: 'image/png',
            status: { type: 'requires-action', reason: 'composer-send' },
            path: '/uploads/A.png',
            uploadSessionId: 'upload-owner',
            ...(mode === 'scratchlist' ? { hubAttachment: { id: 'hub-a' } } : {}),
        }
        return { adapter, attachment, cleanup, deleteUploadFile, deleteScratchlistAttachment }
    }

    it('allows the composer to remove a chip before remote cleanup settles', async () => {
        const { adapter, attachment, cleanup, deleteUploadFile, deleteScratchlistAttachment } = setup()
        const removed = vi.fn()
        const removal = adapter.remove(attachment as never).then(removed)
        try {
            await vi.waitFor(() => expect(removed).toHaveBeenCalledOnce(), { timeout: 500 })
            if (mode === 'scratchlist') {
                expect(deleteScratchlistAttachment).toHaveBeenCalledExactlyOnceWith('current-session', 'hub-a')
                expect(deleteUploadFile).not.toHaveBeenCalled()
            } else {
                expect(deleteUploadFile).toHaveBeenCalledExactlyOnceWith(
                    mode === 'chat' ? 'upload-owner' : 'current-session', '/uploads/A.png',
                )
                expect(deleteScratchlistAttachment).not.toHaveBeenCalled()
            }
        } finally {
            cleanup.resolve()
            await removal
        }
    })

    it('handles a cleanup rejection after the attachment has been removed', async () => {
        const { adapter, attachment, cleanup } = setup()
        const removed = vi.fn()
        const removal = adapter.remove(attachment as never).then(removed)
        try {
            await vi.waitFor(() => expect(removed).toHaveBeenCalledOnce(), { timeout: 500 })
        } finally {
            cleanup.reject(new Error('Network unavailable'))
            await removal
        }
    })
})

it('cleans up a cancelled chat upload without publishing its late completion', async () => {
    const upload = deferred<{ success: boolean, path: string }>()
    const started = deferred<void>()
    const deleteUploadFile = vi.fn().mockResolvedValue({ success: true })
    const adapter = createAttachmentAdapter({
        uploadFile: vi.fn(() => { started.resolve(); return upload.promise }),
        deleteUploadFile,
    } as never, 'upload-owner')
    const iterator = adapter.add({ file: new File(['a'], 'A.txt', { type: 'text/plain' }) }) as AsyncGenerator
    await iterator.next()
    const uploading = await iterator.next()
    const completion = iterator.next()
    await started.promise
    await adapter.remove(uploading.value)
    upload.resolve({ success: true, path: '/uploads/late.txt' })
    expect(await completion).toEqual({ done: true, value: undefined })
    expect(deleteUploadFile).toHaveBeenCalledExactlyOnceWith('upload-owner', '/uploads/late.txt')
})
