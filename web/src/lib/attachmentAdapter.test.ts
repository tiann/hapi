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

    it('assigns a fresh id when a restored failed upload is retried', async () => {
        const drafts = await import('./composer-attachment-drafts')
        const { createAttachmentAdapter } = await import('./attachmentAdapter')
        const file = new File(['broken'], 'broken.txt', { type: 'text/plain', lastModified: 123 })
        drafts.saveDraftAttachments('session-1', [{ id: 'restored-failed', file }])
        const [restored] = await drafts.getDraftAttachments('session-1')
        expect(restored).toBeDefined()

        const uploadFile = vi.fn()
            .mockResolvedValueOnce({ success: false })
            .mockResolvedValueOnce({ success: true, path: '/uploads/retried.txt' })
        const adapter = createAttachmentAdapter({ uploadFile } as never, 'session-1')

        const firstEmitted: Record<string, unknown>[] = []
        for await (const attachment of adapter.add({ file: restored! }) as AsyncIterable<Record<string, unknown>>) {
            firstEmitted.push(attachment)
        }
        const failed = firstEmitted.at(-1)!
        expect(failed).toMatchObject({
            id: 'restored-failed',
            status: { type: 'incomplete', reason: 'error' },
        })
        await adapter.remove(failed as never)

        const retryFile = new File([restored!], restored!.name, {
            type: restored!.type,
            lastModified: restored!.lastModified,
        })
        const retriedEmitted: Record<string, unknown>[] = []
        for await (const attachment of adapter.add({ file: retryFile }) as AsyncIterable<Record<string, unknown>>) {
            retriedEmitted.push(attachment)
        }

        expect(uploadFile).toHaveBeenCalledTimes(2)
        expect(retriedEmitted.at(-1)).toMatchObject({
            status: { type: 'requires-action', reason: 'composer-send' },
            path: '/uploads/retried.txt',
        })
        expect(retriedEmitted.at(-1)?.id).not.toBe('restored-failed')
    })

    it('marks deterministic size failures as non-retryable', async () => {
        const { createAttachmentAdapter, MAX_UPLOAD_BYTES } = await import('./attachmentAdapter')
        const file = new File(['too-large'], 'too-large.txt', { type: 'text/plain' })
        Object.defineProperty(file, 'size', { value: MAX_UPLOAD_BYTES + 1 })
        const uploadFile = vi.fn()
        const adapter = createAttachmentAdapter({ uploadFile } as never, 'session-1')
        const emitted: Record<string, unknown>[] = []

        for await (const attachment of adapter.add({ file }) as AsyncIterable<Record<string, unknown>>) {
            emitted.push(attachment)
        }

        expect(emitted.at(-1)).toMatchObject({
            status: { type: 'incomplete', reason: 'error' },
            retryable: false,
        })
        expect(uploadFile).not.toHaveBeenCalled()
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

    it('hands an inactive attachment to the resumed session before uploading', async () => {
        const { createAttachmentAdapter } = await import('./attachmentAdapter')
        const file = new File(['image'], 'ready.png', { type: 'image/png' })
        const uploadFile = vi.fn().mockResolvedValue({ success: true, path: '/uploads/ready.png' })
        const resolveSessionId = vi.fn().mockResolvedValue('session-resumed')
        const onSessionResolved = vi.fn().mockResolvedValue(undefined)
        const adapter = createAttachmentAdapter(
            { uploadFile } as never,
            'session-inactive',
            resolveSessionId,
            onSessionResolved,
        )

        const additions = adapter.add({ file }) as AsyncIterable<unknown>
        for await (const _attachment of additions) {
            // Consume the upload lifecycle.
        }

        expect(resolveSessionId).toHaveBeenCalledOnce()
        expect(onSessionResolved).toHaveBeenCalledWith('session-resumed', expect.objectContaining({
            id: expect.any(String),
            file,
            isCancelled: expect.any(Function),
        }))
        expect(uploadFile).not.toHaveBeenCalled()

    })

    it('still hands off after resume when the attachment is cancelled mid-flight', async () => {
        const { createAttachmentAdapter } = await import('./attachmentAdapter')
        const file = new File(['image'], 'ready.png', { type: 'image/png' })
        const uploadFile = vi.fn().mockResolvedValue({ success: true, path: '/uploads/ready.png' })
        let releaseResolve!: (sessionId: string) => void
        let markResolveStarted!: () => void
        const resolveSessionReady = new Promise<void>((resolve) => {
            markResolveStarted = resolve
        })
        const resolveSessionId = vi.fn().mockImplementation(() => {
            markResolveStarted()
            return new Promise<string>((resolve) => {
                releaseResolve = resolve
            })
        })
        const onSessionResolved = vi.fn().mockResolvedValue(undefined)
        const adapter = createAttachmentAdapter(
            { uploadFile } as never,
            'session-inactive',
            resolveSessionId,
            onSessionResolved,
        )

        const additions = adapter.add({ file }) as AsyncIterable<Record<string, unknown>>
        const iterator = additions[Symbol.asyncIterator]()
        const first = await iterator.next()
        const pendingId = first.value?.id as string
        expect(pendingId).toBeTruthy()

        const remainder = iterator.next()
        await resolveSessionReady
        await adapter.remove({ id: pendingId } as never)
        releaseResolve('session-resumed')
        await remainder

        expect(resolveSessionId).toHaveBeenCalledOnce()
        // Resume already merged the source session away — hand off with a live
        // cancellation predicate (never drop the id), and never upload.
        expect(onSessionResolved).toHaveBeenCalledWith('session-resumed', expect.objectContaining({
            id: pendingId,
            file,
            isCancelled: expect.any(Function),
        }))
        const handoff = onSessionResolved.mock.calls[0]?.[1] as { isCancelled: () => boolean }
        expect(handoff.isCancelled()).toBe(true)
        expect(uploadFile).not.toHaveBeenCalled()
    })

    it('shares one resume promise across staggered inactive attachment generators', async () => {
        const { createAttachmentAdapter } = await import('./attachmentAdapter')
        const file1 = new File(['one'], 'one.txt', { type: 'text/plain' })
        const file2 = new File(['two'], 'two.txt', { type: 'text/plain' })
        const uploadFile = vi.fn()
        let resolveResume!: (sessionId: string) => void
        let resumeCalls = 0
        let uploadResolution: Promise<string> | undefined
        const resolveSessionId = vi.fn(() => {
            resumeCalls += 1
            return new Promise<string>((resolve) => {
                resolveResume = resolve
            })
        })
        const resolveUploadSession = () => {
            uploadResolution ??= resolveSessionId().catch((error) => {
                uploadResolution = undefined
                throw error
            })
            return uploadResolution
        }
        const onSessionResolved = vi.fn().mockResolvedValue(undefined)
        const adapter = createAttachmentAdapter(
            { uploadFile } as never,
            'session-inactive',
            resolveUploadSession,
            onSessionResolved,
        )

        const first = (async () => {
            for await (const _ of adapter.add({ file: file1 }) as AsyncIterable<unknown>) {
                // consume
            }
        })()
        const second = (async () => {
            for await (const _ of adapter.add({ file: file2 }) as AsyncIterable<unknown>) {
                // consume
            }
        })()

        await vi.waitFor(() => {
            expect(resumeCalls).toBe(1)
        })
        resolveResume('session-resumed')
        await Promise.all([first, second])
        expect(resumeCalls).toBe(1)
        expect(onSessionResolved).toHaveBeenCalled()
        expect(uploadFile).not.toHaveBeenCalled()
    })

    it('streams files above CHUNKED_UPLOAD_THRESHOLD_BYTES without reading them into FileReader', async () => {
        const { createAttachmentAdapter } = await import('./attachmentAdapter')
        const tenMiB = 10 * 1024 * 1024
        const fourMiB = 4 * 1024 * 1024
        const file = new File([new Uint8Array(tenMiB)], 'archive.zip', { type: 'application/zip' })
        const readSpy = vi.spyOn(FileReader.prototype, 'readAsDataURL')
        readSpy.mockClear()

        const initChunkedUpload = vi.fn().mockResolvedValue({
            success: true,
            uploadId: 'upload-123',
            chunkSize: fourMiB,
        })
        const chunkSizes: number[] = []
        const uploadFileChunk = vi.fn(async (_sid: string, _uid: string, _index: number, chunk: Blob) => {
            chunkSizes.push(chunk.size)
            return { success: true, receivedBytes: chunkSizes.reduce((sum, size) => sum + size, 0) }
        })
        const finalizeChunkedUpload = vi.fn().mockResolvedValue({
            success: true,
            path: '/uploads/archive.zip',
        })
        const uploadFile = vi.fn()

        const adapter = createAttachmentAdapter({
            uploadFile,
            initChunkedUpload,
            uploadFileChunk,
            finalizeChunkedUpload,
        } as never, 'session-1')

        const emitted: Record<string, unknown>[] = []
        for await (const item of adapter.add({ file }) as AsyncIterable<Record<string, unknown>>) {
            emitted.push(item)
        }

        expect(readSpy).not.toHaveBeenCalled()
        expect(uploadFile).not.toHaveBeenCalled()
        expect(initChunkedUpload).toHaveBeenCalledWith(
            'session-1',
            { filename: 'archive.zip', size: tenMiB, mimeType: 'application/zip' }
        )
        expect(uploadFileChunk).toHaveBeenCalledTimes(3)
        expect(chunkSizes).toEqual([fourMiB, fourMiB, 2 * 1024 * 1024])
        expect(finalizeChunkedUpload).toHaveBeenCalledWith(
            'session-1',
            'upload-123'
        )
        expect(emitted.at(-1)).toMatchObject({
            status: { type: 'requires-action', reason: 'composer-send' },
            path: '/uploads/archive.zip',
        })
    })

    it('marks server 413 upload_too_large rejections as non-retryable without sending chunks', async () => {
        const { ApiError } = await import('@/api/client')
        const { createAttachmentAdapter } = await import('./attachmentAdapter')
        const file = new File([new Uint8Array(9 * 1024 * 1024)], 'huge.bin', { type: 'application/octet-stream' })

        const initChunkedUpload = vi.fn().mockRejectedValue(
            new ApiError('HTTP 413 Payload Too Large', 413, 'upload_too_large')
        )
        const uploadFileChunk = vi.fn()

        const adapter = createAttachmentAdapter({
            initChunkedUpload,
            uploadFileChunk,
        } as never, 'session-1')

        const emitted: Record<string, unknown>[] = []
        for await (const item of adapter.add({ file }) as AsyncIterable<Record<string, unknown>>) {
            emitted.push(item)
        }

        expect(uploadFileChunk).not.toHaveBeenCalled()
        expect(emitted.at(-1)).toMatchObject({
            status: { type: 'incomplete', reason: 'error' },
            retryable: false,
        })
    })

    it('aborts the HTTP signal and calls abortChunkedUpload when removed mid-stream', async () => {
        const { createAttachmentAdapter } = await import('./attachmentAdapter')
        const file = new File([new Uint8Array(10 * 1024 * 1024)], 'video.mp4', { type: 'video/mp4' })

        const initChunkedUpload = vi.fn().mockResolvedValue({
            success: true,
            uploadId: 'upload-abort',
            chunkSize: 4 * 1024 * 1024,
        })
        let resolveFirstChunkStarted!: (signal: AbortSignal) => void
        const firstChunkStarted = new Promise<AbortSignal>((resolve) => {
            resolveFirstChunkStarted = resolve
        })
        const uploadFileChunk = vi.fn((_sid: string, _uid: string, _idx: number, _chunk: Blob, opts?: { signal?: AbortSignal }) => {
            return new Promise((_resolve, reject) => {
                resolveFirstChunkStarted(opts!.signal!)
                opts?.signal?.addEventListener('abort', () => {
                    reject(new DOMException('Aborted', 'AbortError'))
                })
            })
        })
        const abortChunkedUpload = vi.fn().mockResolvedValue({ success: true })

        const adapter = createAttachmentAdapter({
            initChunkedUpload,
            uploadFileChunk,
            abortChunkedUpload,
        } as never, 'session-1')

        const emitted: Record<string, unknown>[] = []
        const consumption = (async () => {
            for await (const item of adapter.add({ file }) as AsyncIterable<Record<string, unknown>>) {
                emitted.push(item)
            }
        })()

        const signal = await firstChunkStarted
        const initialAttachment = emitted[0]!
        await adapter.remove(initialAttachment as never)
        await consumption

        expect(signal.aborted).toBe(true)
        expect(abortChunkedUpload).toHaveBeenCalledWith('session-1', 'upload-abort')
        expect(emitted.some((item) => (item.status as { type?: string })?.type === 'incomplete')).toBe(false)
    })

    it('falls back to legacy uploadFile for 9-50 MiB files on older runners and refuses >50 MiB cleanly', async () => {
        const { ApiError } = await import('@/api/client')
        const { createAttachmentAdapter } = await import('./attachmentAdapter')
        const initChunkedUpload = vi.fn().mockRejectedValue(
            new ApiError('HTTP 503 Service Unavailable', 503, 'rpc_target_missing')
        )
        const uploadFile = vi.fn().mockResolvedValue({ success: true, path: '/uploads/legacy.bin' })

        const tenMiBFile = new File([new Uint8Array(10 * 1024 * 1024)], 'legacy.bin', { type: 'application/octet-stream' })
        const adapter = createAttachmentAdapter({ initChunkedUpload, uploadFile } as never, 'session-1')
        const emittedFallback: Record<string, unknown>[] = []
        for await (const item of adapter.add({ file: tenMiBFile }) as AsyncIterable<Record<string, unknown>>) {
            emittedFallback.push(item)
        }
        expect(uploadFile).toHaveBeenCalledTimes(1)
        expect(emittedFallback.at(-1)).toMatchObject({
            status: { type: 'requires-action', reason: 'composer-send' },
            path: '/uploads/legacy.bin',
        })

        const sixtyMiBFile = new File(['x'], 'too-big-legacy.bin', { type: 'application/octet-stream' })
        Object.defineProperty(sixtyMiBFile, 'size', { value: 60 * 1024 * 1024 })
        const readSpy = vi.spyOn(FileReader.prototype, 'readAsDataURL')
        readSpy.mockClear()
        const emittedTooBig: Record<string, unknown>[] = []
        for await (const item of adapter.add({ file: sixtyMiBFile }) as AsyncIterable<Record<string, unknown>>) {
            emittedTooBig.push(item)
        }
        expect(readSpy).not.toHaveBeenCalled()
        expect(uploadFile).toHaveBeenCalledTimes(1)
        expect(emittedTooBig.at(-1)).toMatchObject({
            status: { type: 'incomplete', reason: 'error' },
            retryable: false,
        })
    })

    it('aborts the server upload when removed while initChunkedUpload is pending', async () => {
        const { createAttachmentAdapter } = await import('./attachmentAdapter')
        let resolveInit: ((value: { success: true; uploadId: string; chunkSize: number }) => void) | undefined
        const initChunkedUpload = vi.fn().mockImplementation(
            () => new Promise((resolve) => {
                resolveInit = resolve
            })
        )
        const uploadFileChunk = vi.fn()
        const finalizeChunkedUpload = vi.fn()
        const abortChunkedUpload = vi.fn().mockResolvedValue({ success: true })
        const adapter = createAttachmentAdapter({
            uploadFile: vi.fn(),
            initChunkedUpload,
            uploadFileChunk,
            finalizeChunkedUpload,
            abortChunkedUpload,
            deleteUploadFile: vi.fn().mockResolvedValue({ success: true }),
        } as never, 'session-1')

        const tenMiB = 10 * 1024 * 1024
        const file = new File([new Uint8Array(tenMiB)], 'pending-init.bin', { type: 'application/octet-stream' })

        const iter = (adapter.add({ file }) as AsyncIterable<Record<string, unknown>>)[Symbol.asyncIterator]()
        const firstStep = await iter.next()
        expect(firstStep.value).toMatchObject({ id: expect.any(String), status: { type: 'running' } })
        const attachment = firstStep.value!

        const remainingPromise = (async () => {
            const items: Record<string, unknown>[] = []
            while (true) {
                const next = await iter.next()
                if (next.done) {
                    break
                }
                items.push(next.value)
            }
            return items
        })()

        await adapter.remove(attachment as never)
        expect(abortChunkedUpload).not.toHaveBeenCalled()

        resolveInit?.({ success: true, uploadId: 'late-upload-id', chunkSize: 4 * 1024 * 1024 })
        const remaining = await remainingPromise
        expect(remaining).toEqual([])
        expect(abortChunkedUpload).toHaveBeenCalledWith('session-1', 'late-upload-id')
        expect(uploadFileChunk).not.toHaveBeenCalled()
        expect(finalizeChunkedUpload).not.toHaveBeenCalled()
    })

    it('deletes the finalized file when removed while finalizeChunkedUpload is pending', async () => {
        const { createAttachmentAdapter } = await import('./attachmentAdapter')
        let resolveFinalize: ((value: { success: true; path: string }) => void) | undefined
        const initChunkedUpload = vi.fn().mockResolvedValue({
            success: true,
            uploadId: 'upload-fin-1',
            chunkSize: 10 * 1024 * 1024,
        })
        const uploadFileChunk = vi.fn().mockResolvedValue({ success: true, index: 0, receivedBytes: 10 * 1024 * 1024 })
        const finalizeChunkedUpload = vi.fn().mockImplementation(
            () => new Promise((resolve) => {
                resolveFinalize = resolve
            })
        )
        const abortChunkedUpload = vi.fn().mockResolvedValue({ success: true })
        const deleteUploadFile = vi.fn().mockResolvedValue({ success: true })
        const adapter = createAttachmentAdapter({
            uploadFile: vi.fn(),
            initChunkedUpload,
            uploadFileChunk,
            finalizeChunkedUpload,
            abortChunkedUpload,
            deleteUploadFile,
        } as never, 'session-1')

        const tenMiB = 10 * 1024 * 1024
        const file = new File([new Uint8Array(tenMiB)], 'pending-fin.bin', { type: 'application/octet-stream' })

        const iter = (adapter.add({ file }) as AsyncIterable<Record<string, unknown>>)[Symbol.asyncIterator]()
        const step1 = await iter.next()
        const step2 = await iter.next()
        const step3 = await iter.next()
        expect(step1.done).toBe(false)
        expect(step2.done).toBe(false)
        expect(step3.done).toBe(false)

        const remainingPromise = (async () => {
            const items: Record<string, unknown>[] = []
            while (true) {
                const next = await iter.next()
                if (next.done) {
                    break
                }
                items.push(next.value)
            }
            return items
        })()

        await vi.waitFor(() => {
            expect(finalizeChunkedUpload).toHaveBeenCalledTimes(1)
        })

        await adapter.remove(step3.value as never)
        expect(abortChunkedUpload).not.toHaveBeenCalled()
        expect(deleteUploadFile).not.toHaveBeenCalled()

        resolveFinalize?.({ success: true, path: '/tmp/blobs/pending-fin.bin' })
        const remaining = await remainingPromise
        expect(remaining).toEqual([])
        expect(abortChunkedUpload).not.toHaveBeenCalled()
        expect(deleteUploadFile).toHaveBeenCalledWith('session-1', '/tmp/blobs/pending-fin.bin')
    })
})
