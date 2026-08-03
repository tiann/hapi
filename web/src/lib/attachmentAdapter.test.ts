import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function stubUploadThenPreviewReadFailure(): void {
    let readCount = 0

    class FileReaderMock {
        result: string | ArrayBuffer | null = null
        onload: FileReader['onload'] = null
        onerror: FileReader['onerror'] = null

        readAsDataURL(): void {
            readCount += 1
            if (readCount === 1) {
                this.result = 'data:image/png;base64,dXBsb2Fk'
                this.onload?.call(this as unknown as FileReader, {} as ProgressEvent<FileReader>)
                return
            }
            this.onerror?.call(this as unknown as FileReader, {} as ProgressEvent<FileReader>)
        }
    }

    vi.stubGlobal('FileReader', FileReaderMock)
}

function stubUploadThenDeferredPreviewReadFailure(): {
    previewStarted: Promise<void>
    failPreview: () => void
} {
    let readCount = 0
    let resolvePreviewStarted!: () => void
    let failPreviewRead: (() => void) | undefined
    const previewStarted = new Promise<void>((resolve) => {
        resolvePreviewStarted = resolve
    })

    class FileReaderMock {
        result: string | ArrayBuffer | null = null
        onload: FileReader['onload'] = null
        onerror: FileReader['onerror'] = null

        readAsDataURL(): void {
            readCount += 1
            if (readCount === 1) {
                this.result = 'data:image/png;base64,dXBsb2Fk'
                this.onload?.call(this as unknown as FileReader, {} as ProgressEvent<FileReader>)
                return
            }
            failPreviewRead = () => {
                this.onerror?.call(this as unknown as FileReader, {} as ProgressEvent<FileReader>)
            }
            resolvePreviewStarted()
        }
    }

    vi.stubGlobal('FileReader', FileReaderMock)
    return {
        previewStarted,
        failPreview: () => {
            if (!failPreviewRead) throw new Error('Preview read did not start')
            failPreviewRead()
        }
    }
}

describe('attachmentAdapter', () => {
    beforeEach(() => {
        vi.stubGlobal('indexedDB', undefined)
        vi.resetModules()
    })

    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it('uses the assistant-ui wildcard sentinel so all files reach the adapter', async () => {
        const { createAttachmentAdapter } = await import('./attachmentAdapter')
        const adapter = createAttachmentAdapter({} as never, 'session-1')

        expect(adapter.accept).toBe('*')
    })

    it('restores an uploaded draft without uploading it again', async () => {
        const drafts = await import('./composer-attachment-drafts')
        const { createAttachmentAdapter } = await import('./attachmentAdapter')
        const file = new File(['image'], 'ready.png', { type: 'image/png' })
        drafts.saveDraftAttachments('session-1', [{
            id: 'attachment-ready',
            file,
            path: '/uploads/ready.png',
            previewUrl: 'data:image/png;base64,aW1hZ2U=',
        }])
        const [restored] = await drafts.getDraftAttachments('session-1')
        expect(restored).toBeDefined()

        const uploadFile = vi.fn()
        const adapter = createAttachmentAdapter({ uploadFile } as never, 'session-1')
        const emitted = []
        const additions = adapter.add({ file: restored! }) as AsyncIterable<unknown>
        for await (const attachment of additions) {
            emitted.push(attachment)
        }

        expect(uploadFile).not.toHaveBeenCalled()
        expect(emitted).toEqual([expect.objectContaining({
            id: 'attachment-ready',
            path: '/uploads/ready.png',
            previewUrl: 'data:image/png;base64,aW1hZ2U=',
            status: { type: 'requires-action', reason: 'composer-send' },
        })])
    })

    it('keeps a successful upload ready when image preview generation fails', async () => {
        stubUploadThenPreviewReadFailure()
        const { createAttachmentAdapter } = await import('./attachmentAdapter')
        const uploadFile = vi.fn().mockResolvedValue({ success: true, path: '/uploads/proof.png' })
        const deleteUploadFile = vi.fn().mockResolvedValue({ success: true })
        const adapter = createAttachmentAdapter({ uploadFile, deleteUploadFile } as never, 'session-1')
        const file = new File(['proof'], 'proof.png', { type: 'image/png' })
        const states: import('@assistant-ui/react').PendingAttachment[] = []

        for await (const state of adapter.add({ file }) as AsyncGenerator<import('@assistant-ui/react').PendingAttachment>) {
            states.push(state)
        }

        const ready = states.at(-1) as import('@assistant-ui/react').PendingAttachment & {
            path?: string
            previewUrl?: string
        }
        expect(uploadFile).toHaveBeenCalledTimes(1)
        expect(uploadFile).toHaveBeenCalledWith('session-1', 'proof.png', 'dXBsb2Fk', 'image/png')
        expect(ready).toMatchObject({
            type: 'file',
            name: 'proof.png',
            status: { type: 'requires-action', reason: 'composer-send' },
            path: '/uploads/proof.png',
        })
        expect(ready.id).toEqual(expect.any(String))
        expect(ready.previewUrl).toBeUndefined()

        const sent = await adapter.send(ready)
        expect(JSON.parse((sent.content[0] as { text: string }).text)).toEqual({
            __attachmentMetadata: {
                id: ready.id,
                filename: 'proof.png',
                mimeType: 'image/png',
                size: file.size,
                path: '/uploads/proof.png',
            },
        })

        await adapter.remove(ready)
        expect(deleteUploadFile).toHaveBeenCalledWith('session-1', '/uploads/proof.png')
    })

    it('cleans up a successful upload when cancellation occurs during preview generation', async () => {
        const preview = stubUploadThenDeferredPreviewReadFailure()
        const { createAttachmentAdapter } = await import('./attachmentAdapter')
        const uploadFile = vi.fn().mockResolvedValue({ success: true, path: '/uploads/proof.png' })
        const deleteUploadFile = vi.fn().mockResolvedValue({ success: true })
        const adapter = createAttachmentAdapter({ uploadFile, deleteUploadFile } as never, 'session-1')
        const file = new File(['proof'], 'proof.png', { type: 'image/png' })
        const iter = adapter.add({ file }) as AsyncGenerator<import('@assistant-ui/react').PendingAttachment>

        const initial = await iter.next()
        const uploading = await iter.next()
        expect(uploading.value).toMatchObject({
            status: { type: 'running', reason: 'uploading', progress: 50 },
        })
        expect((uploading.value as { path?: string }).path).toBeUndefined()

        const completion = iter.next()
        await preview.previewStarted
        expect(uploadFile).toHaveBeenCalledTimes(1)
        await adapter.remove(uploading.value)
        preview.failPreview()

        expect(await completion).toEqual({ done: true, value: undefined })
        expect([initial.value, uploading.value]).toEqual([
            expect.objectContaining({ status: { type: 'running', reason: 'uploading', progress: 0 } }),
            expect.objectContaining({ status: { type: 'running', reason: 'uploading', progress: 50 } }),
        ])
        expect(deleteUploadFile).toHaveBeenCalledTimes(1)
        expect(deleteUploadFile).toHaveBeenCalledWith('session-1', '/uploads/proof.png')
    })
})
