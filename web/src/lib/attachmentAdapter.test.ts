import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

async function collectAdditions(
    file: File,
    uploadFile = vi.fn(async () => ({ success: true, path: '/uploads/file' }))
) {
    const { createAttachmentAdapter } = await import('./attachmentAdapter')
    const adapter = createAttachmentAdapter({ uploadFile } as never, 'session-1')
    const additions = adapter.add({ file }) as AsyncIterable<Record<string, unknown>>
    const emitted: Record<string, unknown>[] = []

    for await (const attachment of additions) {
        emitted.push(attachment)
    }

    return { emitted, uploadFile }
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

    it('uploads an image when the initial preview read fails', async () => {
        let readCount = 0
        class FileReaderMock {
            result: string | ArrayBuffer | null = null
            onload: FileReader['onload'] = null
            onerror: FileReader['onerror'] = null

            readAsDataURL(): void {
                readCount += 1
                if (readCount === 1) {
                    this.onerror?.call(this as unknown as FileReader, {} as ProgressEvent<FileReader>)
                    return
                }
                this.result = 'data:image/png;base64,dXBsb2Fk'
                this.onload?.call(this as unknown as FileReader, {} as ProgressEvent<FileReader>)
            }
        }
        vi.stubGlobal('FileReader', FileReaderMock)

        const file = new File(['proof'], 'proof.png', { type: 'image/png' })
        const { emitted, uploadFile } = await collectAdditions(file)

        expect(readCount).toBe(2)
        expect(uploadFile).toHaveBeenCalledWith('session-1', 'proof.png', 'dXBsb2Fk', 'image/png')
        expect(emitted.at(-1)).toMatchObject({
            status: { type: 'requires-action', reason: 'composer-send' },
            path: '/uploads/file'
        })
        expect(emitted.every((attachment) => attachment.previewUrl === undefined)).toBe(true)
    })
})

describe('attachmentAdapter image previews', () => {
    it('includes the preview URL in every image upload state', async () => {
        const file = new File(['image'], 'photo.png', { type: 'image/png' })
        const readSpy = vi.spyOn(FileReader.prototype, 'readAsDataURL')
        const { emitted } = await collectAdditions(file)

        expect(emitted).toHaveLength(3)
        expect(emitted[0]).toMatchObject({
            previewUrl: 'data:image/png;base64,aW1hZ2U=',
            status: { type: 'running', progress: 0 }
        })
        expect(emitted[1]).toMatchObject({
            previewUrl: 'data:image/png;base64,aW1hZ2U=',
            status: { type: 'running', progress: 50 }
        })
        expect(emitted[2]).toMatchObject({
            previewUrl: 'data:image/png;base64,aW1hZ2U=',
            status: { type: 'requires-action' }
        })
        expect(readSpy).toHaveBeenCalledTimes(1)
    })

    it('does not generate previews for non-image attachments', async () => {
        const file = new File(['notes'], 'notes.txt', { type: 'text/plain' })
        const { emitted } = await collectAdditions(file)

        expect(emitted).toHaveLength(3)
        expect(emitted.every((attachment) => attachment.previewUrl === undefined)).toBe(true)
    })
})
