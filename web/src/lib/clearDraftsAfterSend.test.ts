import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/composer-drafts', () => ({
    clearDraft: vi.fn(),
}))

import { clearDraft } from '@/lib/composer-drafts'
import { clearDraftsAfterSend } from './clearDraftsAfterSend'

const mockClearDraft = vi.mocked(clearDraft)

describe('clearDraftsAfterSend', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('clears the sent session draft', () => {
        clearDraftsAfterSend('session-A', 'session-A')
        expect(mockClearDraft).toHaveBeenCalledWith('session-A')
        expect(mockClearDraft).toHaveBeenCalledTimes(1)
    })

    it('clears both drafts when session was resolved to a different ID', () => {
        clearDraftsAfterSend('resolved-B', 'session-A')
        expect(mockClearDraft).toHaveBeenCalledWith('resolved-B')
        expect(mockClearDraft).toHaveBeenCalledWith('session-A')
        expect(mockClearDraft).toHaveBeenCalledTimes(2)
    })

    it('only clears sent session when route session is null', () => {
        clearDraftsAfterSend('session-A', null)
        expect(mockClearDraft).toHaveBeenCalledWith('session-A')
        expect(mockClearDraft).toHaveBeenCalledTimes(1)
    })
})
