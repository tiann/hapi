import { describe, expect, it, vi } from 'vitest'
import { createScratchlistAttachmentAdapter } from './scratchlistAttachmentAdapter'

describe('createScratchlistAttachmentAdapter', () => {
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
