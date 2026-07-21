import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/composer-drafts', () => ({
    clearDraft: vi.fn(),
}))
vi.mock('@/lib/composer-attachment-drafts', () => ({
    clearDraftAttachments: vi.fn(),
}))

import { clearDraft } from '@/lib/composer-drafts'
import { clearDraftAttachments } from '@/lib/composer-attachment-drafts'
import { clearDraftsAfterSend } from './clearDraftsAfterSend'

const mockClearDraft = vi.mocked(clearDraft)
const mockClearDraftAttachments = vi.mocked(clearDraftAttachments)

describe('clearDraftsAfterSend', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('clears the sent session draft', () => {
        clearDraftsAfterSend('session-A', 'session-A')
        expect(mockClearDraft).toHaveBeenCalledWith('session-A')
        expect(mockClearDraft).toHaveBeenCalledTimes(1)
        expect(mockClearDraftAttachments).toHaveBeenCalledWith('session-A')
    })

    it('clears both drafts when session was resolved to a different ID', () => {
        clearDraftsAfterSend('resolved-B', 'session-A')
        expect(mockClearDraft).toHaveBeenCalledWith('resolved-B')
        expect(mockClearDraft).toHaveBeenCalledWith('session-A')
        expect(mockClearDraft).toHaveBeenCalledTimes(2)
        expect(mockClearDraftAttachments).toHaveBeenCalledWith('resolved-B')
        expect(mockClearDraftAttachments).toHaveBeenCalledWith('session-A')
        expect(mockClearDraftAttachments).toHaveBeenCalledTimes(2)
    })

    it('only clears sent session when route session is null', () => {
        clearDraftsAfterSend('session-A', null)
        expect(mockClearDraft).toHaveBeenCalledWith('session-A')
        expect(mockClearDraft).toHaveBeenCalledTimes(1)
        expect(mockClearDraftAttachments).toHaveBeenCalledWith('session-A')
    })
})
