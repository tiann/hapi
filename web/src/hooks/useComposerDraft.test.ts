import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

// Mock composer-drafts module
vi.mock('@/lib/composer-drafts', () => ({
    getDraft: vi.fn(() => ''),
    saveDraft: vi.fn(),
}))
vi.mock('@/lib/composer-attachment-drafts', () => ({
    getDraftAttachments: vi.fn(async () => []),
    saveDraftAttachments: vi.fn(),
}))

import { getDraft, saveDraft } from '@/lib/composer-drafts'
import { getDraftAttachments, saveDraftAttachments } from '@/lib/composer-attachment-drafts'
import { useComposerDraft } from './useComposerDraft'

const mockGetDraft = vi.mocked(getDraft)
const mockSaveDraft = vi.mocked(saveDraft)
const mockGetDraftAttachments = vi.mocked(getDraftAttachments)
const mockSaveDraftAttachments = vi.mocked(saveDraftAttachments)

describe('useComposerDraft', () => {
    let rAFCallbacks: Array<() => void>

    beforeEach(() => {
        vi.clearAllMocks()
        mockGetDraft.mockReturnValue('')
        mockGetDraftAttachments.mockResolvedValue([])
        rAFCallbacks = []
        vi.stubGlobal('requestAnimationFrame', vi.fn((cb: () => void) => {
            rAFCallbacks.push(cb)
            return rAFCallbacks.length
        }))
        vi.stubGlobal('cancelAnimationFrame', vi.fn())
    })

    afterEach(() => {
        vi.unstubAllGlobals()
    })

    async function flushRAF() {
        const cbs = [...rAFCallbacks]
        rAFCallbacks = []
        cbs.forEach(cb => cb())
        await Promise.resolve()
        await Promise.resolve()
    }

    it('restores saved draft on mount via requestAnimationFrame', async () => {
        mockGetDraft.mockReturnValue('saved text')
        const setText = vi.fn()

        renderHook(() => useComposerDraft('session-1', '', [], true, setText, vi.fn()))

        // Before rAF fires, setText should not have been called
        expect(setText).not.toHaveBeenCalled()

        // Flush rAF
        await act(async () => flushRAF())
        expect(mockGetDraft).toHaveBeenCalledWith('session-1')
        expect(setText).toHaveBeenCalledWith('saved text')
    })

    it('does not restore draft if composer already has text', async () => {
        mockGetDraft.mockReturnValue('saved text')
        const setText = vi.fn()

        renderHook(() => useComposerDraft('session-1', 'user is typing', [], true, setText, vi.fn()))

        await act(async () => flushRAF())
        expect(setText).not.toHaveBeenCalled()
    })

    it('does not restore if draft is empty', async () => {
        mockGetDraft.mockReturnValue('')
        const setText = vi.fn()

        renderHook(() => useComposerDraft('session-1', '', [], true, setText, vi.fn()))

        await act(async () => flushRAF())
        expect(setText).not.toHaveBeenCalled()
    })

    it('saves draft on unmount after rAF has fired', async () => {
        mockGetDraft.mockReturnValue('')
        const setText = vi.fn()

        const { unmount, rerender } = renderHook(
            ({ text }) => useComposerDraft('session-1', text, [], true, setText, vi.fn()),
            { initialProps: { text: '' } },
        )

        // Fire rAF to set draftReady = true
        await act(async () => flushRAF())

        // Simulate user typing
        rerender({ text: 'my draft' })

        unmount()

        expect(mockSaveDraft).toHaveBeenCalledWith('session-1', 'my draft')
        expect(mockSaveDraftAttachments).toHaveBeenCalledWith('session-1', [])
    })

    it('does not save draft on unmount before rAF has fired', () => {
        mockGetDraft.mockReturnValue('')
        const setText = vi.fn()

        const { unmount } = renderHook(
            () => useComposerDraft('session-1', 'some text', [], true, setText, vi.fn()),
        )

        // Unmount before rAF fires (draftReady is still false)
        unmount()

        expect(mockSaveDraft).not.toHaveBeenCalled()
        expect(vi.mocked(cancelAnimationFrame)).toHaveBeenCalled()
    })

    it('does nothing when sessionId is undefined', async () => {
        const setText = vi.fn()

        const { unmount } = renderHook(
            () => useComposerDraft(undefined, 'text', [], true, setText, vi.fn()),
        )

        await act(async () => flushRAF())
        unmount()

        expect(mockGetDraft).not.toHaveBeenCalled()
        expect(mockSaveDraft).not.toHaveBeenCalled()
        expect(setText).not.toHaveBeenCalled()
    })

    it('restores saved attachments when the composer is empty', async () => {
        const file = new File(['image'], 'image.png', { type: 'image/png' })
        mockGetDraftAttachments.mockResolvedValue([file])
        const addAttachment = vi.fn(async () => {})

        renderHook(() => useComposerDraft('session-1', '', [], true, vi.fn(), addAttachment))
        await act(async () => flushRAF())

        expect(addAttachment).toHaveBeenCalledWith(file)
    })

    it('does not duplicate saved attachments when the composer already has files', async () => {
        const current = new File(['current'], 'current.png', { type: 'image/png' })
        const saved = new File(['saved'], 'saved.png', { type: 'image/png' })
        mockGetDraftAttachments.mockResolvedValue([saved])
        const addAttachment = vi.fn(async () => {})

        renderHook(() => useComposerDraft('session-1', '', [{ id: 'current', file: current }], true, vi.fn(), addAttachment))
        await act(async () => flushRAF())

        expect(addAttachment).not.toHaveBeenCalled()
    })

    it('preserves saved attachments while the attachment adapter is unavailable', async () => {
        const saved = new File(['saved'], 'saved.png', { type: 'image/png' })
        mockGetDraftAttachments.mockResolvedValue([saved])
        const addAttachment = vi.fn(async () => {})

        const { unmount } = renderHook(() => (
            useComposerDraft('session-1', '', [], false, vi.fn(), addAttachment)
        ))
        await act(async () => flushRAF())
        unmount()

        expect(mockGetDraftAttachments).not.toHaveBeenCalled()
        expect(addAttachment).not.toHaveBeenCalled()
        expect(mockSaveDraftAttachments).not.toHaveBeenCalled()
    })
})
