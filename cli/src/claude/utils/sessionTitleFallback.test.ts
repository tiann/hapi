import { describe, expect, it, vi } from 'vitest'
import { applySessionTitleFallback, createSessionTitleFallback } from './sessionTitleFallback'

describe('Claude session title fallback', () => {
    it('normalizes whitespace and truncates long initial messages', () => {
        expect(createSessionTitleFallback('  Review\n\nthis   project  ')).toBe('Review this project')

        const title = createSessionTitleFallback('a'.repeat(100))
        expect(title).toBe('a'.repeat(79) + '…')
    })

    it('writes a summary when no title exists', () => {
        const sendClaudeSessionMessage = vi.fn()

        expect(applySessionTitleFallback({
            hasSessionTitle: () => false,
            sendClaudeSessionMessage
        }, 'Review this project')).toBe(true)

        expect(sendClaudeSessionMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'summary',
            summary: 'Review this project'
        }))
    })

    it('does not replace an existing title or use an empty message', () => {
        const sendClaudeSessionMessage = vi.fn()

        expect(applySessionTitleFallback({
            hasSessionTitle: () => true,
            sendClaudeSessionMessage
        }, 'Review this project')).toBe(false)
        expect(applySessionTitleFallback({
            hasSessionTitle: () => false,
            sendClaudeSessionMessage
        }, '  \n  ')).toBe(false)

        expect(sendClaudeSessionMessage).not.toHaveBeenCalled()
    })
})
