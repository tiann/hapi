import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, render, screen } from '@testing-library/react'
import { createElement, useEffect, useState } from 'react'

// Mock composer-drafts module
vi.mock('@/lib/composer-drafts', () => ({
    getDraft: vi.fn(() => ''),
    saveDraft: vi.fn(),
}))
vi.mock('@/lib/composer-attachment-drafts', () => ({
    getDraftAttachments: vi.fn(async () => []),
    getRestoredUploadMetadata: vi.fn(() => undefined),
    saveDraftAttachments: vi.fn(),
}))

import { getDraft, saveDraft } from '@/lib/composer-drafts'
import { getDraftAttachments, getRestoredUploadMetadata, saveDraftAttachments } from '@/lib/composer-attachment-drafts'
import { useComposerDraft } from './useComposerDraft'

const mockGetDraft = vi.mocked(getDraft)
const mockSaveDraft = vi.mocked(saveDraft)
const mockGetDraftAttachments = vi.mocked(getDraftAttachments)
const mockGetRestoredUploadMetadata = vi.mocked(getRestoredUploadMetadata)
const mockSaveDraftAttachments = vi.mocked(saveDraftAttachments)

describe('useComposerDraft', () => {
    let rAFCallbacks: Array<() => void>

    beforeEach(() => {
        vi.clearAllMocks()
        mockGetDraft.mockReturnValue('')
        mockGetDraftAttachments.mockResolvedValue([])
        mockGetRestoredUploadMetadata.mockReturnValue(undefined)
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

        const { result } = renderHook(() => useComposerDraft('session-1', '', [], true, setText, vi.fn()))

        // Before rAF fires, setText should not have been called and hydration
        // must prevent failed-send recovery from racing ahead of persistence.
        expect(setText).not.toHaveBeenCalled()
        expect(result.current).toEqual({ sessionId: 'session-1', complete: false, restoredAny: false , hasStoredAttachments: false })

        // Flush rAF + attachment hydration.
        await act(async () => flushRAF())
        expect(mockGetDraft).toHaveBeenCalledWith('session-1')
        expect(setText).toHaveBeenCalledWith('saved text')
        expect(result.current).toEqual({ sessionId: 'session-1', complete: true, restoredAny: true , hasStoredAttachments: false })
    })

    it('restores only missing stored attachments when a visible pick already exists', async () => {
        const storedA = new File(['a'], 'a.txt')
        const visibleB = new File(['b'], 'b.txt')
        mockGetDraftAttachments.mockResolvedValue([storedA, visibleB])
        mockGetRestoredUploadMetadata.mockImplementation((file: File) => {
            if (file === storedA) return { id: 'stored-a' }
            if (file === visibleB) return { id: 'visible-b' }
            return undefined
        })
        const addAttachment = vi.fn().mockResolvedValue(undefined)
        const visible = [{ id: 'visible-b', file: visibleB }]

        const { result, rerender } = renderHook(
            ({ canRestore, attachments }) => useComposerDraft(
                'session-1',
                '',
                attachments,
                canRestore,
                vi.fn(),
                addAttachment,
            ),
            { initialProps: { canRestore: false, attachments: visible } },
        )

        await act(async () => flushRAF())
        expect(result.current.complete).toBe(true)
        expect(addAttachment).not.toHaveBeenCalled()

        // Same-id resume flips inactive → active with B already visible.
        rerender({ canRestore: true, attachments: visible })
        await act(async () => flushRAF())
        await act(async () => {
            await Promise.resolve()
            await Promise.resolve()
        })

        expect(addAttachment).toHaveBeenCalledTimes(1)
        expect(addAttachment).toHaveBeenCalledWith(storedA)
        expect(result.current.complete).toBe(true)
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

        const { result } = renderHook(() => useComposerDraft('session-1', '', [], true, vi.fn(), addAttachment))
        await act(async () => flushRAF())

        expect(addAttachment).toHaveBeenCalledWith(file)
        expect(result.current).toEqual({
            sessionId: 'session-1',
            complete: true,
            restoredAny: true,
            hasStoredAttachments: true,
        })
    })

    it('does not duplicate a stored attachment that is already visible by id', async () => {
        const current = new File(['current'], 'current.png', { type: 'image/png' })
        mockGetDraftAttachments.mockResolvedValue([current])
        mockGetRestoredUploadMetadata.mockReturnValue({ id: 'current' })
        const addAttachment = vi.fn(async () => {})

        renderHook(() => useComposerDraft('session-1', '', [{ id: 'current', file: current }], true, vi.fn(), addAttachment))
        await act(async () => flushRAF())

        expect(addAttachment).not.toHaveBeenCalled()
    })

    it('restores a stored sibling when a different attachment is already visible', async () => {
        const current = new File(['current'], 'current.png', { type: 'image/png' })
        const saved = new File(['saved'], 'saved.png', { type: 'image/png' })
        mockGetDraftAttachments.mockResolvedValue([saved])
        mockGetRestoredUploadMetadata.mockImplementation((file: File) => (
            file === saved ? { id: 'saved' } : undefined
        ))
        const addAttachment = vi.fn(async () => {})

        renderHook(() => useComposerDraft('session-1', '', [{ id: 'current', file: current }], true, vi.fn(), addAttachment))
        await act(async () => flushRAF())

        expect(addAttachment).toHaveBeenCalledWith(saved)
    })

    it('preserves saved attachments while the attachment adapter is unavailable', async () => {
        const saved = new File(['saved'], 'saved.png', { type: 'image/png' })
        mockGetDraftAttachments.mockResolvedValue([saved])
        const addAttachment = vi.fn(async () => {})

        const { result, unmount } = renderHook(() => (
            useComposerDraft('session-1', '', [], false, vi.fn(), addAttachment)
        ))
        await act(async () => flushRAF())

        expect(mockGetDraftAttachments).toHaveBeenCalledWith('session-1')
        expect(addAttachment).not.toHaveBeenCalled()
        expect(result.current).toEqual({
            sessionId: 'session-1',
            complete: true,
            restoredAny: false,
            hasStoredAttachments: true,
        })
        unmount()
        expect(mockSaveDraftAttachments).not.toHaveBeenCalled()
    })

    it('merges a visible inactive selection into stored attachments on unmount', async () => {
        const stored = new File(['kept'], 'kept.txt', { type: 'text/plain' })
        const partial = new File(['picked'], 'picked.txt', { type: 'text/plain' })
        mockGetDraftAttachments.mockResolvedValue([stored])
        const { unmount } = renderHook(() => (
            useComposerDraft(
                'session-1',
                'typed',
                [{ id: 'partial', file: partial }],
                false,
                vi.fn(),
                vi.fn(),
            )
        ))
        await act(async () => flushRAF())
        unmount()
        await act(async () => {
            await Promise.resolve()
            await Promise.resolve()
        })

        expect(mockSaveDraft).toHaveBeenCalledWith('session-1', 'typed')
        expect(mockSaveDraftAttachments).toHaveBeenCalledWith(
            'session-1',
            expect.arrayContaining([
                expect.objectContaining({ file: stored }),
                expect.objectContaining({ id: 'partial', file: partial }),
            ]),
        )
    })
    it('reports immediate complete hydration when no session exists', () => {
        const { result } = renderHook(() => useComposerDraft(undefined, '', [], true, vi.fn(), vi.fn()))
        expect(result.current).toEqual({ sessionId: undefined, complete: true, restoredAny: false , hasStoredAttachments: false })
    })

    it('returns to pending hydration when the session changes', async () => {
        const { result, rerender } = renderHook(
            ({ sessionId }) => useComposerDraft(sessionId, '', [], false, vi.fn(), vi.fn()),
            { initialProps: { sessionId: 'session-1' as string | undefined } },
        )
        await act(async () => flushRAF())
        expect(result.current).toEqual({ sessionId: 'session-1', complete: true, restoredAny: false , hasStoredAttachments: false })

        rerender({ sessionId: 'session-2' })
        expect(result.current).toEqual({ sessionId: 'session-2', complete: false, restoredAny: false , hasStoredAttachments: false })
        await act(async () => flushRAF())
        expect(result.current).toEqual({ sessionId: 'session-2', complete: true, restoredAny: false , hasStoredAttachments: false })
    })

    it('lets persisted replacement hydration win over an implicit failed-send restore', async () => {
        mockGetDraft.mockReturnValue('persisted replacement')

        function DraftVsImplicitRestore() {
            const [text, setText] = useState('')
            const [errorCleared, setErrorCleared] = useState(false)
            const hydration = useComposerDraft('session-race', text, [], false, setText, vi.fn())

            // Mirrors HappyComposer's guard===null branch: no old error text
            // may be written until this session's hydration is complete.
            useEffect(() => {
                if (hydration.sessionId !== 'session-race' || !hydration.complete) return
                if (hydration.restoredAny) {
                    setErrorCleared(true)
                    return
                }
                setText('stale failed-send text')
            }, [hydration])

            return createElement('output', { 'data-testid': 'draft-race' }, `${text}|${errorCleared}`)
        }

        render(createElement(DraftVsImplicitRestore))
        expect(screen.getByTestId('draft-race')).toHaveTextContent('|false')

        await act(async () => flushRAF())

        expect(screen.getByTestId('draft-race')).toHaveTextContent('persisted replacement|true')
        expect(screen.getByTestId('draft-race')).not.toHaveTextContent('stale failed-send text')
    })

    it('ignores a deferred old-session attachment restore after the session changes', async () => {
        let resolveOldFiles: ((files: File[]) => void) | undefined
        const oldFiles = new Promise<File[]>((resolve) => { resolveOldFiles = resolve })
        const oldAttachment = new File(['old'], 'old.png', { type: 'image/png' })
        mockGetDraftAttachments.mockImplementation((sessionId) => (
            sessionId === 'session-1' ? oldFiles : Promise.resolve([])
        ))
        const addAttachment = vi.fn(async () => {})
        const { result, rerender } = renderHook(
            ({ sessionId }) => useComposerDraft(sessionId, '', [], true, vi.fn(), addAttachment),
            { initialProps: { sessionId: 'session-1' } },
        )

        await act(async () => flushRAF())
        expect(result.current).toEqual({ sessionId: 'session-1', complete: false, restoredAny: false , hasStoredAttachments: false })

        rerender({ sessionId: 'session-2' })
        expect(result.current).toEqual({ sessionId: 'session-2', complete: false, restoredAny: false , hasStoredAttachments: false })

        await act(async () => {
            resolveOldFiles!([oldAttachment])
            await Promise.resolve()
            await Promise.resolve()
        })
        expect(result.current).toEqual({ sessionId: 'session-2', complete: false, restoredAny: false , hasStoredAttachments: false })
        expect(addAttachment).not.toHaveBeenCalled()

        await act(async () => flushRAF())
        expect(result.current).toEqual({ sessionId: 'session-2', complete: true, restoredAny: false , hasStoredAttachments: false })
    })

    it('does not mark hydration restored when every saved attachment rejects', async () => {
        const file = new File(['broken'], 'broken.png', { type: 'image/png' })
        mockGetDraftAttachments.mockResolvedValue([file])
        const addAttachment = vi.fn(async () => { throw new Error('upload failed') })
        const { result } = renderHook(() => useComposerDraft('session-1', '', [], true, vi.fn(), addAttachment))

        await act(async () => flushRAF())

        expect(addAttachment).toHaveBeenCalledWith(file)
        expect(result.current).toEqual({
            sessionId: 'session-1',
            complete: true,
            restoredAny: false,
            hasStoredAttachments: true,
        })
    })

    it('marks hydration restored when at least one saved attachment succeeds', async () => {
        const rejected = new File(['broken'], 'broken.png', { type: 'image/png' })
        const restored = new File(['ok'], 'ok.png', { type: 'image/png' })
        mockGetDraftAttachments.mockResolvedValue([rejected, restored])
        const addAttachment = vi.fn(async (file: File) => {
            if (file === rejected) throw new Error('upload failed')
        })
        const { result } = renderHook(() => useComposerDraft('session-1', '', [], true, vi.fn(), addAttachment))

        await act(async () => flushRAF())

        expect(addAttachment).toHaveBeenCalledTimes(2)
        expect(result.current).toEqual({
            sessionId: 'session-1',
            complete: true,
            restoredAny: true,
            hasStoredAttachments: true,
        })
    })

    it('allows implicit failed-send restoration when every persisted attachment fails', async () => {
        const file = new File(['broken'], 'broken.png', { type: 'image/png' })
        mockGetDraftAttachments.mockResolvedValue([file])

        function AttachmentFailureVsImplicitRestore() {
            const [text, setText] = useState('')
            const [errorCleared, setErrorCleared] = useState(false)
            const hydration = useComposerDraft('session-race', text, [], true, setText, async () => {
                throw new Error('upload failed')
            })
            useEffect(() => {
                if (hydration.sessionId !== 'session-race' || !hydration.complete) return
                if (hydration.restoredAny) {
                    setErrorCleared(true)
                    return
                }
                setText('failed-send text')
            }, [hydration])
            return createElement('output', { 'data-testid': 'attachment-race' }, `${text}|${errorCleared}`)
        }

        render(createElement(AttachmentFailureVsImplicitRestore))
        await act(async () => flushRAF())
        expect(screen.getByTestId('attachment-race')).toHaveTextContent('failed-send text|false')
    })

})
