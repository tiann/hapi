import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('composer-attachment-drafts', () => {
    beforeEach(() => {
        vi.stubGlobal('indexedDB', undefined)
        vi.resetModules()
    })

    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it('keeps files available in memory when IndexedDB is unavailable', async () => {
        const mod = await import('./composer-attachment-drafts')
        const file = new File(['image bytes'], 'pasted.png', {
            type: 'image/png',
            lastModified: 123,
        })

        mod.saveDraftAttachments('session-1', [{ id: 'attachment-1', file }])
        const restored = await mod.getDraftAttachments('session-1')

        expect(restored).toHaveLength(1)
        expect(restored[0]).not.toBe(file)
        expect(restored[0]?.name).toBe('pasted.png')
        expect(restored[0]?.type).toBe('image/png')
        expect(restored[0]?.lastModified).toBe(123)
        expect(restored[0]?.size).toBe(file.size)
    })

    it('isolates attachment drafts by session', async () => {
        const mod = await import('./composer-attachment-drafts')
        mod.saveDraftAttachments('session-a', [{ id: 'a', file: new File(['a'], 'a.txt') }])
        mod.saveDraftAttachments('session-b', [{ id: 'b', file: new File(['b'], 'b.txt') }])

        expect((await mod.getDraftAttachments('session-a'))[0]?.name).toBe('a.txt')
        expect((await mod.getDraftAttachments('session-b'))[0]?.name).toBe('b.txt')
    })

    it('clears cached attachment drafts', async () => {
        const mod = await import('./composer-attachment-drafts')
        mod.saveDraftAttachments('session-1', [{ id: 'x', file: new File(['x'], 'x.txt') }])

        mod.clearDraftAttachments('session-1')

        expect(await mod.getDraftAttachments('session-1')).toEqual([])
    })

    it('does not read stale IndexedDB data while a clear is being persisted', async () => {
        const mod = await import('./composer-attachment-drafts')
        mod.saveDraftAttachments('session-1', [{ id: 'x', file: new File(['x'], 'x.txt') }])
        mod.clearDraftAttachments('session-1')
        await new Promise((resolve) => setTimeout(resolve, 0))

        const open = vi.fn(() => {
            throw new Error('cleared drafts must be served from the cache tombstone')
        })
        vi.stubGlobal('indexedDB', { open })

        expect(await mod.getDraftAttachments('session-1')).toEqual([])
        expect(open).not.toHaveBeenCalled()
    })

    it('retains completed upload metadata on restored files', async () => {
        const mod = await import('./composer-attachment-drafts')
        const file = new File(['image'], 'ready.png', { type: 'image/png' })
        mod.saveDraftAttachments('session-1', [{
            id: 'attachment-ready',
            file,
            path: '/uploads/ready.png',
            previewUrl: 'data:image/png;base64,aW1hZ2U=',
        }])

        const [restored] = await mod.getDraftAttachments('session-1')

        expect(restored && mod.getRestoredUploadMetadata(restored)).toEqual({
            id: 'attachment-ready',
            path: '/uploads/ready.png',
            previewUrl: 'data:image/png;base64,aW1hZ2U=',
        })
    })
})
