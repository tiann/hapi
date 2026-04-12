import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

// Mock composer-drafts module
vi.mock('@/lib/composer-drafts', () => ({
    getDraft: vi.fn(() => ''),
    saveDraft: vi.fn(),
}))

import { getDraft, saveDraft } from '@/lib/composer-drafts'
import { useComposerDraft } from './useComposerDraft'

const mockGetDraft = vi.mocked(getDraft)
const mockSaveDraft = vi.mocked(saveDraft)

describe('useComposerDraft', () => {
    let rAFCallbacks: Array<() => void>

    beforeEach(() => {
        vi.clearAllMocks()
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

    function flushRAF() {
        const cbs = [...rAFCallbacks]
        rAFCallbacks = []
        cbs.forEach(cb => cb())
    }

    it('restores saved draft on mount via requestAnimationFrame', () => {
        mockGetDraft.mockReturnValue('saved text')
        const setText = vi.fn()

        renderHook(() => useComposerDraft('session-1', '', setText))

        // Before rAF fires, setText should not have been called
        expect(setText).not.toHaveBeenCalled()

        // Flush rAF
        act(() => flushRAF())

        expect(mockGetDraft).toHaveBeenCalledWith('session-1')
        expect(setText).toHaveBeenCalledWith('saved text')
    })

    it('does not restore draft if composer already has text', () => {
        mockGetDraft.mockReturnValue('saved text')
        const setText = vi.fn()

        renderHook(() => useComposerDraft('session-1', 'user is typing', setText))

        act(() => flushRAF())

        expect(setText).not.toHaveBeenCalled()
    })

    it('does not restore if draft is empty', () => {
        mockGetDraft.mockReturnValue('')
        const setText = vi.fn()

        renderHook(() => useComposerDraft('session-1', '', setText))

        act(() => flushRAF())

        expect(setText).not.toHaveBeenCalled()
    })

    it('saves draft on unmount after rAF has fired', () => {
        mockGetDraft.mockReturnValue('')
        const setText = vi.fn()

        const { unmount, rerender } = renderHook(
            ({ text }) => useComposerDraft('session-1', text, setText),
            { initialProps: { text: '' } },
        )

        // Fire rAF to set draftReady = true
        act(() => flushRAF())

        // Simulate user typing
        rerender({ text: 'my draft' })

        unmount()

        expect(mockSaveDraft).toHaveBeenCalledWith('session-1', 'my draft')
    })

    it('does not save draft on unmount before rAF has fired', () => {
        mockGetDraft.mockReturnValue('')
        const setText = vi.fn()

        const { unmount } = renderHook(
            () => useComposerDraft('session-1', 'some text', setText),
        )

        // Unmount before rAF fires (draftReady is still false)
        unmount()

        expect(mockSaveDraft).not.toHaveBeenCalled()
        expect(vi.mocked(cancelAnimationFrame)).toHaveBeenCalled()
    })

    it('does nothing when sessionId is undefined', () => {
        const setText = vi.fn()

        const { unmount } = renderHook(
            () => useComposerDraft(undefined, 'text', setText),
        )

        act(() => flushRAF())
        unmount()

        expect(mockGetDraft).not.toHaveBeenCalled()
        expect(mockSaveDraft).not.toHaveBeenCalled()
        expect(setText).not.toHaveBeenCalled()
    })
})
