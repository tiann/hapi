import { describe, expect, it, vi } from 'vitest'
import {
    createScratchlistAttachmentAdapter,
    hubAttachmentFromRestoredDraft,
} from './scratchlistAttachmentAdapter'

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
