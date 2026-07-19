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
})
