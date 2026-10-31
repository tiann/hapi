import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    clearScratchlistAttachmentPreviewCache,
    getScratchlistAttachmentPreview,
    retainScratchlistAttachmentPreview,
    releaseScratchlistAttachmentPreview,
    rememberScratchlistAttachmentObjectUrl,
} from './scratchlistAttachmentPreview'

function attachment(id: string, size = 1) {
    return {
        id,
        filename: `${id}.png`,
        mimeType: 'image/png',
        size,
        path: `hapi-hub:scratchlist/default/session/${id}.png`,
    }
}

const originalRevokeObjectURL = URL.revokeObjectURL

afterEach(() => {
    clearScratchlistAttachmentPreviewCache()
    vi.restoreAllMocks()
    Object.defineProperty(URL, 'revokeObjectURL', {
        configurable: true,
        value: originalRevokeObjectURL,
    })
})

describe('scratchlist attachment preview cache', () => {
    it('releases an explicitly removed object URL', () => {
        const revoke = vi.fn()
        Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke })
        const item = attachment('removed')
        rememberScratchlistAttachmentObjectUrl(item, 'blob:removed')

        releaseScratchlistAttachmentPreview(item.id)

        expect(revoke).toHaveBeenCalledWith('blob:removed')
        expect(getScratchlistAttachmentPreview(item)).toBeUndefined()
    })

    it('keeps the first URL when duplicate preview downloads finish', () => {
        const revoke = vi.fn()
        Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke })
        const item = attachment('duplicate-download')

        expect(rememberScratchlistAttachmentObjectUrl(item, 'blob:first')).toBe('blob:first')
        expect(rememberScratchlistAttachmentObjectUrl(item, 'blob:second')).toBe('blob:first')

        expect(getScratchlistAttachmentPreview(item)).toBe('blob:first')
        expect(revoke).not.toHaveBeenCalledWith('blob:first')
        expect(revoke).toHaveBeenCalledWith('blob:second')
    })

    it('bounds the cache and evicts the least recently used preview', () => {
        const revoke = vi.fn()
        Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke })
        const first = attachment('first')
        rememberScratchlistAttachmentObjectUrl(first, 'blob:first')
        for (let index = 1; index <= 64; index += 1) {
            const item = attachment(`item-${index}`)
            rememberScratchlistAttachmentObjectUrl(item, `blob:${item.id}`)
        }

        expect(getScratchlistAttachmentPreview(first)).toBeUndefined()
        expect(revoke).toHaveBeenCalledWith('blob:first')
    })

    it('does not evict a preview while its thumbnail is mounted', () => {
        const revoke = vi.fn()
        Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke })
        const first = attachment('mounted-first')
        const release = retainScratchlistAttachmentPreview(first.id)
        rememberScratchlistAttachmentObjectUrl(first, 'blob:mounted-first')
        for (let index = 1; index <= 64; index += 1) {
            const item = attachment(`mounted-item-${index}`)
            rememberScratchlistAttachmentObjectUrl(item, `blob:${item.id}`)
        }

        expect(getScratchlistAttachmentPreview(first)).toBe('blob:mounted-first')
        expect(revoke).not.toHaveBeenCalledWith('blob:mounted-first')

        release()
        for (let index = 65; index <= 128; index += 1) {
            const item = attachment(`mounted-item-${index}`)
            rememberScratchlistAttachmentObjectUrl(item, `blob:${item.id}`)
        }
        expect(getScratchlistAttachmentPreview(first)).toBeUndefined()
        expect(revoke).toHaveBeenCalledWith('blob:mounted-first')
    })

    it('evicts previews when their attachment bytes exceed the cache budget', () => {
        const revoke = vi.fn()
        Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke })
        const first = attachment('large-first', 8 * 1024 * 1024)
        const second = attachment('large-second', 8 * 1024 * 1024)
        const third = attachment('large-third', 8 * 1024 * 1024)

        rememberScratchlistAttachmentObjectUrl(first, 'blob:large-first')
        rememberScratchlistAttachmentObjectUrl(second, 'blob:large-second')
        rememberScratchlistAttachmentObjectUrl(third, 'blob:large-third')

        expect(getScratchlistAttachmentPreview(first)).toBeUndefined()
        expect(getScratchlistAttachmentPreview(second)).toBe('blob:large-second')
        expect(getScratchlistAttachmentPreview(third)).toBe('blob:large-third')
        expect(revoke).toHaveBeenCalledWith('blob:large-first')
    })
})
