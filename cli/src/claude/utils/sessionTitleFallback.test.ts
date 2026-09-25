import { describe, expect, it, vi } from 'vitest'
import { applySessionTitleFallback, createSessionTitleFallback } from './sessionTitleFallback'

describe('Claude session title fallback', () => {
    it('normalizes whitespace and truncates long initial messages', () => {
        expect(createSessionTitleFallback('  Review\n\nthis   project  ')).toBe('Review this project')

        const title = createSessionTitleFallback('a'.repeat(100))
        expect(title).toBe('a'.repeat(79) + '…')
    })

    it('writes a summary when no title exists', () => {
        const updateMetadata = vi.fn((handler) => handler({}))

        expect(applySessionTitleFallback({
            updateMetadata
        }, 'Review this project')).toBe(true)

        expect(updateMetadata).toHaveReturnedWith(expect.objectContaining({
            summary: expect.objectContaining({ text: 'Review this project' })
        }))
    })

    it('does not replace an existing title or use an empty message', () => {
        const manualMetadata = { name: 'Manual title' }
        const updateMetadata = vi.fn((handler) => handler(manualMetadata))

        expect(applySessionTitleFallback({
            updateMetadata
        }, 'Review this project')).toBe(true)
        expect(applySessionTitleFallback({
            updateMetadata
        }, '  \n  ')).toBe(false)

        expect(updateMetadata).toHaveBeenCalledTimes(1)
        expect(updateMetadata).toHaveReturnedWith(manualMetadata)
    })

    it('replaces a provisional Fork summary with the native title', () => {
        const forkMetadata = {
            forkedFrom: 'parent-session',
            summary: { text: 'Fork: Parent title', updatedAt: 1 }
        }
        const updateMetadata = vi.fn((handler) => handler(forkMetadata))

        expect(applySessionTitleFallback({ updateMetadata }, 'Native title', {
            allowForkSeedReplacement: true
        })).toBe(true)

        expect(updateMetadata).toHaveReturnedWith(expect.objectContaining({
            summary: expect.objectContaining({ text: 'Native title' })
        }))
    })

    it('keeps a manual name authoritative on a forked session', () => {
        const forkMetadata = {
            name: 'Manual child title',
            forkedFrom: 'parent-session',
            summary: { text: 'Fork: Parent title', updatedAt: 1 }
        }
        const updateMetadata = vi.fn((handler) => handler(forkMetadata))

        expect(applySessionTitleFallback({ updateMetadata }, 'Native title')).toBe(true)
        expect(updateMetadata).toHaveReturnedWith(forkMetadata)
    })

    it('keeps the Fork seed for a first-message fallback', () => {
        const forkMetadata = {
            forkedFrom: 'parent-session',
            summary: { text: 'Fork: Parent title', updatedAt: 1 }
        }
        const updateMetadata = vi.fn((handler) => handler(forkMetadata))

        expect(applySessionTitleFallback({ updateMetadata }, 'continue')).toBe(true)
        expect(updateMetadata).toHaveReturnedWith(forkMetadata)
    })
})
