import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    createScratchlistAttachmentAdapter,
    hubAttachmentFromRestoredDraft,
} from './scratchlistAttachmentAdapter'

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

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('hubAttachmentFromRestoredDraft', () => {
    it('reconstructs hub metadata from hapi-hub:scratchlist storage key', () => {
        const file = new File([new Uint8Array([1, 2, 3])], 'proof.png', { type: 'image/png' })
        const path = 'hapi-hub:scratchlist/default/session-1/a1b2c3d4-e5f6-4789-a012-3456789abcde-proof.png'
        expect(hubAttachmentFromRestoredDraft(path, file, 'image/png')).toEqual({
            id: 'a1b2c3d4-e5f6-4789-a012-3456789abcde',
            filename: 'proof.png',
            mimeType: 'image/png',
            size: 3,
            path,
        })
    })

    it('returns null for non-hub paths', () => {
        const file = new File(['x'], 'x.txt', { type: 'text/plain' })
        expect(hubAttachmentFromRestoredDraft('/uploads/x.txt', file, 'text/plain')).toBeNull()
    })
})

describe('createScratchlistAttachmentAdapter', () => {
    it('uses the assistant-ui wildcard sentinel so all files reach the adapter', () => {
        const adapter = createScratchlistAttachmentAdapter({} as never, 'session-1')

        expect(adapter.accept).toBe('*')
    })

    it('reuses restored hub path without re-uploading', async () => {
        const drafts = await import('./composer-attachment-drafts')
        const hubId = 'a1b2c3d4-e5f6-4789-a012-3456789abcde'
        const path = `hapi-hub:scratchlist/default/session-1/${hubId}-proof.png`
        const file = new File([new Uint8Array([137, 80, 78, 71])], 'proof.png', { type: 'image/png' })
        drafts.saveDraftAttachments('session-restore', [{
            id: 'composer-att-1',
            file,
            path,
            previewUrl: 'data:image/png;base64,aW1hZ2U=',
        }])
        const [restored] = await drafts.getDraftAttachments('session-restore')
        expect(restored).toBeTruthy()

        const uploadScratchlistAttachment = vi.fn()
        const api = { uploadScratchlistAttachment } as never
        const adapter = createScratchlistAttachmentAdapter(api, 'session-1')

        const iter = adapter.add({ file: restored! }) as AsyncGenerator<
            import('@assistant-ui/react').PendingAttachment
        >
        const states: import('@assistant-ui/react').PendingAttachment[] = []
        for await (const pending of iter) {
            states.push(pending)
        }

        expect(uploadScratchlistAttachment).not.toHaveBeenCalled()
        expect(states).toHaveLength(1)
        const ready = states[0] as {
            id: string
            status: unknown
            path?: string
            hubAttachment?: { id: string; path: string }
            previewUrl?: string
        }
        expect(ready.id).toBe('composer-att-1')
        expect(ready.status).toEqual({ type: 'requires-action', reason: 'composer-send' })
        expect(ready.path).toBe(path)
        expect(ready.hubAttachment).toEqual({
            id: hubId,
            filename: 'proof.png',
            mimeType: 'image/png',
            size: restored!.size,
            path,
        })
        expect(ready.previewUrl).toBe('data:image/png;base64,aW1hZ2U=')
    })

    it('sets path on requires-action yield so composer canSend unlocks after hub upload', async () => {
        const uploadScratchlistAttachment = vi.fn().mockResolvedValue({
            success: true,
            attachment: {
                id: 'hub-1',
                filename: 'proof.png',
                mimeType: 'image/png',
                size: 12,
                path: '/scratchlist/sessions/s1/proof.png',
            },
        })
        const api = { uploadScratchlistAttachment } as never
        const adapter = createScratchlistAttachmentAdapter(api, 'session-1')
        const file = new File([new Uint8Array([137, 80, 78, 71])], 'proof.png', { type: 'image/png' })

        const iter = adapter.add({ file }) as AsyncGenerator<import('@assistant-ui/react').PendingAttachment>
        const states: import('@assistant-ui/react').PendingAttachment[] = []
        for await (const pending of iter) {
            states.push(pending)
        }

        const ready = states.at(-1)
        expect(ready?.status).toEqual({ type: 'requires-action', reason: 'composer-send' })
        expect((ready as { path?: string }).path).toBe('/scratchlist/sessions/s1/proof.png')
    })

    it('keeps a successful upload ready when image preview generation fails', async () => {
        stubUploadThenPreviewReadFailure()
        const attachment = {
            id: 'hub-proof',
            filename: 'proof.png',
            mimeType: 'image/png',
            size: 5,
            path: 'hapi-hub:scratchlist/default/session-1/hub-proof-proof.png',
        }
        const uploadScratchlistAttachment = vi.fn().mockResolvedValue({ success: true, attachment })
        const deleteScratchlistAttachment = vi.fn().mockResolvedValue(undefined)
        const adapter = createScratchlistAttachmentAdapter(
            { uploadScratchlistAttachment, deleteScratchlistAttachment } as never,
            'session-1'
        )
        const file = new File(['proof'], 'proof.png', { type: 'image/png' })
        const states: import('@assistant-ui/react').PendingAttachment[] = []

        for await (const state of adapter.add({ file }) as AsyncGenerator<import('@assistant-ui/react').PendingAttachment>) {
            states.push(state)
        }

        const ready = states.at(-1) as import('@assistant-ui/react').PendingAttachment & {
            path?: string
            hubAttachment?: typeof attachment
            previewUrl?: string
        }
        expect(uploadScratchlistAttachment).toHaveBeenCalledTimes(1)
        expect(uploadScratchlistAttachment).toHaveBeenCalledWith('session-1', 'proof.png', 'dXBsb2Fk', 'image/png')
        expect(ready).toMatchObject({
            type: 'file',
            name: 'proof.png',
            status: { type: 'requires-action', reason: 'composer-send' },
            path: attachment.path,
            hubAttachment: attachment,
        })
        expect(ready.id).toEqual(expect.any(String))
        expect(ready.previewUrl).toBeUndefined()

        const sent = await adapter.send(ready)
        expect(JSON.parse((sent.content[0] as { text: string }).text)).toEqual({
            __attachmentMetadata: attachment,
        })

        await adapter.remove(ready)
        expect(deleteScratchlistAttachment).toHaveBeenCalledWith('session-1', attachment.id)
    })

    it('cleans up a successful hub upload when cancellation occurs during preview generation', async () => {
        const preview = stubUploadThenDeferredPreviewReadFailure()
        const attachment = {
            id: 'hub-proof',
            filename: 'proof.png',
            mimeType: 'image/png',
            size: 5,
            path: 'hapi-hub:scratchlist/default/session-1/hub-proof-proof.png',
        }
        const uploadScratchlistAttachment = vi.fn().mockResolvedValue({ success: true, attachment })
        const deleteScratchlistAttachment = vi.fn().mockResolvedValue(undefined)
        const adapter = createScratchlistAttachmentAdapter(
            { uploadScratchlistAttachment, deleteScratchlistAttachment } as never,
            'session-1'
        )
        const file = new File(['proof'], 'proof.png', { type: 'image/png' })
        const iter = adapter.add({ file }) as AsyncGenerator<import('@assistant-ui/react').PendingAttachment>

        const initial = await iter.next()
        const uploading = await iter.next()
        expect(uploading.value).toMatchObject({
            status: { type: 'running', reason: 'uploading', progress: 50 },
        })
        expect((uploading.value as { path?: string }).path).toBeUndefined()
        expect((uploading.value as { hubAttachment?: unknown }).hubAttachment).toBeUndefined()

        const completion = iter.next()
        await preview.previewStarted
        expect(uploadScratchlistAttachment).toHaveBeenCalledTimes(1)
        await adapter.remove(uploading.value)
        preview.failPreview()

        expect(await completion).toEqual({ done: true, value: undefined })
        expect([initial.value, uploading.value]).toEqual([
            expect.objectContaining({ status: { type: 'running', reason: 'uploading', progress: 0 } }),
            expect.objectContaining({ status: { type: 'running', reason: 'uploading', progress: 50 } }),
        ])
        expect(deleteScratchlistAttachment).toHaveBeenCalledTimes(1)
        expect(deleteScratchlistAttachment).toHaveBeenCalledWith('session-1', attachment.id)
    })

    it('deletes hub blob when cancel races the in-flight upload completion', async () => {
        let pendingId = ''
        let adapter: ReturnType<typeof createScratchlistAttachmentAdapter>
        const deleteScratchlistAttachment = vi.fn().mockResolvedValue(undefined)
        const uploadScratchlistAttachment = vi.fn().mockImplementation(async () => {
            await adapter.remove({
                id: pendingId,
                type: 'file',
                name: 'proof.png',
                contentType: 'image/png',
                status: { type: 'running', reason: 'uploading', progress: 50 },
            } as never)
            return {
                success: true,
                attachment: {
                    id: 'hub-race',
                    filename: 'proof.png',
                    mimeType: 'image/png',
                    size: 4,
                    path: 'hapi-hub:scratchlist/default/session-1/hub-race-proof.png',
                },
            }
        })
        const api = { uploadScratchlistAttachment, deleteScratchlistAttachment } as never
        adapter = createScratchlistAttachmentAdapter(api, 'session-1')
        const file = new File([new Uint8Array([137, 80, 78, 71])], 'proof.png', { type: 'image/png' })

        const iter = adapter.add({ file }) as AsyncGenerator<import('@assistant-ui/react').PendingAttachment>
        const first = await iter.next()
        pendingId = (first.value as { id: string }).id

        for await (const _pending of iter) {
            // drain
        }

        expect(deleteScratchlistAttachment).toHaveBeenCalledWith('session-1', 'hub-race')
    })
})

describe('createScratchlistAttachmentAdapter.send migrates chat-path chips (#1226)', () => {
    it('uploads pending chat-path file to hub scratchlist and returns hub metadata', async () => {
        const hubAttachment = {
            id: 'hub-migrated',
            filename: 'before-mode.png',
            mimeType: 'image/png',
            size: 4,
            path: 'hapi-hub:scratchlist/default/session-1/hub-migrated-before-mode.png',
        }
        const uploadScratchlistAttachment = vi.fn().mockResolvedValue({
            success: true,
            attachment: hubAttachment,
        })
        const deleteUploadFile = vi.fn().mockResolvedValue(undefined)
        const api = { uploadScratchlistAttachment, deleteUploadFile } as never
        const adapter = createScratchlistAttachmentAdapter(api, 'session-1')
        const file = new File([new Uint8Array([137, 80, 78, 71])], 'before-mode.png', { type: 'image/png' })

        const complete = await adapter.send({
            id: 'composer-chat-1',
            type: 'file',
            name: 'before-mode.png',
            contentType: 'image/png',
            file,
            status: { type: 'requires-action', reason: 'composer-send' },
            path: '/tmp/hapi-blobs/session-1/before-mode.png',
            previewUrl: 'data:image/png;base64,iVBORw0KGgo=',
        } as never)

        expect(uploadScratchlistAttachment).toHaveBeenCalledWith(
            'session-1',
            'before-mode.png',
            expect.any(String),
            'image/png',
        )
        // Chat-path cleanup is deferred until scratchlist.add succeeds (#1226 review).
        expect(deleteUploadFile).not.toHaveBeenCalled()
        expect(complete.content).toEqual([
            {
                type: 'text',
                text: JSON.stringify({
                    __attachmentMetadata: {
                        ...hubAttachment,
                        previewUrl: 'data:image/png;base64,iVBORw0KGgo=',
                        migratedFromPath: '/tmp/hapi-blobs/session-1/before-mode.png',
                    },
                }),
            },
        ])
    })

    it('throws when chat-path migrate upload fails so park does not silently drop', async () => {
        const uploadScratchlistAttachment = vi.fn().mockResolvedValue({
            success: false,
            error: 'quota',
        })
        const api = { uploadScratchlistAttachment, deleteUploadFile: vi.fn() } as never
        const adapter = createScratchlistAttachmentAdapter(api, 'session-1')
        const file = new File([new Uint8Array([1])], 'x.png', { type: 'image/png' })

        await expect(adapter.send({
            id: 'composer-chat-2',
            type: 'file',
            name: 'x.png',
            contentType: 'image/png',
            file,
            status: { type: 'requires-action', reason: 'composer-send' },
            path: '/tmp/hapi-blobs/x.png',
        } as never)).rejects.toThrow(/quota|Failed to migrate/i)
    })

    it('releaseWithoutDelete makes remove a no-op so clearAttachments keeps parked hubs', async () => {
        const deleteScratchlistAttachment = vi.fn()
        const deleteUploadFile = vi.fn()
        const api = { deleteScratchlistAttachment, deleteUploadFile } as never
        const adapter = createScratchlistAttachmentAdapter(api, 'session-1')
        const pending = {
            id: 'composer-hub-1',
            type: 'file' as const,
            name: 'a.png',
            contentType: 'image/png',
            status: { type: 'requires-action' as const, reason: 'composer-send' as const },
            path: 'hapi-hub:scratchlist/default/session-1/hub-1-a.png',
            hubAttachment: {
                id: 'hub-1',
                filename: 'a.png',
                mimeType: 'image/png',
                size: 1,
                path: 'hapi-hub:scratchlist/default/session-1/hub-1-a.png',
            },
        }

        adapter.releaseWithoutDelete([pending.id])
        await adapter.remove(pending as never)

        expect(deleteScratchlistAttachment).not.toHaveBeenCalled()
        expect(deleteUploadFile).not.toHaveBeenCalled()
    })
})
