import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, waitFor } from '@testing-library/react'
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { clearDraft, getDraft, saveDraft } from '@/lib/composer-drafts'
import {
    clearDraftAttachments,
    getDraftAttachments,
    saveDraftAttachments,
    type AttachmentDraftInput,
} from '@/lib/composer-attachment-drafts'
import { useComposerDraft } from '@/hooks/useComposerDraft'
import {
    attachmentDraftRevision,
    clearComposerDraftSnapshot,
    persistInactiveComposerAttachments,
    resetInactiveComposerAttachmentVisibility,
    setComposerDraftSnapshot,
    transferComposerDraft,
    updateComposerDraftTextSnapshot,
} from '@/lib/composer-draft-transfer'

/**
 * Mirrors HappyComposer's post-hydration snapshot effects for the inactive
 * archive → switch → reopen lifecycle without mounting the full chat tree.
 */
function DraftLifecycleComposer(props: {
    sessionId: string
    active: boolean
    initialText?: string
    initialAttachments?: AttachmentDraftInput[]
}): ReactElement {
    const [composerText, setComposerText] = useState(props.initialText ?? '')
    const [attachmentDrafts, setAttachmentDrafts] = useState<AttachmentDraftInput[]>(
        props.initialAttachments ?? [],
    )
    const canRestoreAttachments = props.active
    const attachmentRevision = attachmentDraftRevision(attachmentDrafts)
    const latestTextRef = useRef(composerText)
    latestTextRef.current = composerText
    const attachmentDraftsRef = useRef(attachmentDrafts)
    attachmentDraftsRef.current = attachmentDrafts

    useEffect(() => {
        if (canRestoreAttachments) return
        resetInactiveComposerAttachmentVisibility(props.sessionId)
    }, [canRestoreAttachments, props.sessionId])

    const draftHydration = useComposerDraft(
        props.sessionId,
        composerText,
        attachmentDrafts,
        canRestoreAttachments,
        setComposerText,
        async (file) => {
            setAttachmentDrafts((current) => {
                if (current.some((item) => item.file.name === file.name && item.file.size === file.size)) {
                    return current
                }
                return [...current, { id: `restored-${file.name}`, file }]
            })
        },
    )

    useEffect(() => {
        if (draftHydration.sessionId !== props.sessionId || !draftHydration.complete) return
        if (canRestoreAttachments) {
            setComposerDraftSnapshot(props.sessionId, composerText, attachmentDraftsRef.current)
            return
        }
        updateComposerDraftTextSnapshot(props.sessionId, composerText)
    }, [
        attachmentRevision,
        canRestoreAttachments,
        composerText,
        draftHydration.complete,
        draftHydration.sessionId,
        props.sessionId,
    ])

    useEffect(() => {
        if (draftHydration.sessionId !== props.sessionId || !draftHydration.complete) return
        if (canRestoreAttachments) return
        void persistInactiveComposerAttachments(
            props.sessionId,
            latestTextRef.current,
            attachmentDraftsRef.current,
        )
    }, [
        attachmentRevision,
        canRestoreAttachments,
        draftHydration.complete,
        draftHydration.sessionId,
        props.sessionId,
    ])

    return (
        <div
            data-testid="lifecycle-composer"
            data-session={props.sessionId}
            data-active={String(props.active)}
            data-text={composerText}
            data-attachments={attachmentDrafts.map((item) => item.file.name).join(',')}
            data-hydration={draftHydration.complete ? 'complete' : 'pending'}
        />
    )
}

describe('inactive composer draft lifecycle', () => {
    let rAFCallbacks: Array<() => void>

    beforeEach(() => {
        vi.stubGlobal('indexedDB', undefined)
        sessionStorage.clear()
        rAFCallbacks = []
        vi.stubGlobal('requestAnimationFrame', vi.fn((cb: () => void) => {
            rAFCallbacks.push(cb)
            return rAFCallbacks.length
        }))
        vi.stubGlobal('cancelAnimationFrame', vi.fn())
        for (const sessionId of ['session-source', 'session-other', 'session-reopened']) {
            clearDraft(sessionId)
            clearDraftAttachments(sessionId)
            clearComposerDraftSnapshot(sessionId)
        }
    })

    afterEach(() => {
        vi.unstubAllGlobals()
        for (const sessionId of ['session-source', 'session-other', 'session-reopened']) {
            clearDraft(sessionId)
            clearDraftAttachments(sessionId)
            clearComposerDraftSnapshot(sessionId)
        }
        sessionStorage.clear()
    })

    async function flushRAF() {
        const cbs = [...rAFCallbacks]
        rAFCallbacks = []
        await act(async () => {
            cbs.forEach((cb) => cb())
            await Promise.resolve()
            await Promise.resolve()
        })
    }

    it('keeps persisted attachments across archive, session switch, and reopen to a new id', async () => {
        const file = new File(['payload'], 'notes.txt', { type: 'text/plain' })

        // 1) Active session: user typed text and attached a file.
        const active = render(
            <DraftLifecycleComposer
                sessionId="session-source"
                active
                initialText="draft before archive"
                initialAttachments={[{ id: 'a1', file }]}
            />,
        )
        await flushRAF()
        await waitFor(() => {
            expect(active.getByTestId('lifecycle-composer').dataset.hydration).toBe('complete')
        })
        // useComposerDraft persists text/attachments on unmount (archive / leave session).
        active.unmount()
        expect(getDraft('session-source')).toBe('draft before archive')
        expect((await getDraftAttachments('session-source')).map((item) => item.name)).toEqual(['notes.txt'])

        // 2) Archive / remount inactive: attachments stay in storage, not restored into the adapter.
        const inactive = render(
            <DraftLifecycleComposer
                sessionId="session-source"
                active={false}
            />,
        )
        await flushRAF()
        await waitFor(() => {
            expect(inactive.getByTestId('lifecycle-composer').dataset.hydration).toBe('complete')
        })
        // Text restores; attachments do not (avoids passive resume).
        expect(inactive.getByTestId('lifecycle-composer').dataset.text).toBe('draft before archive')
        expect(inactive.getByTestId('lifecycle-composer').dataset.attachments).toBe('')
        expect((await getDraftAttachments('session-source')).map((item) => item.name)).toEqual(['notes.txt'])

        // 3) Switch away to another session and return to the archived source.
        inactive.unmount()
        const other = render(
            <DraftLifecycleComposer
                sessionId="session-other"
                active
                initialText="other session"
            />,
        )
        await flushRAF()
        await waitFor(() => {
            expect(other.getByTestId('lifecycle-composer').dataset.hydration).toBe('complete')
        })
        other.unmount()

        const inactiveAgain = render(
            <DraftLifecycleComposer
                sessionId="session-source"
                active={false}
            />,
        )
        await flushRAF()
        await waitFor(() => {
            expect(inactiveAgain.getByTestId('lifecycle-composer').dataset.hydration).toBe('complete')
        })
        expect(inactiveAgain.getByTestId('lifecycle-composer').dataset.attachments).toBe('')
        expect((await getDraftAttachments('session-source')).map((item) => item.name)).toEqual(['notes.txt'])

        // 4) Reopen merges into a new session id and must carry text + attachments.
        await transferComposerDraft('session-source', 'session-reopened')
        inactiveAgain.unmount()

        expect(getDraft('session-reopened')).toBe('draft before archive')
        const transferred = await getDraftAttachments('session-reopened')
        expect(transferred).toHaveLength(1)
        expect(transferred[0]?.name).toBe('notes.txt')
        expect(transferred[0]?.size).toBe(file.size)
        expect(transferred[0]?.type).toBe('text/plain')
    })

    it('would lose attachments if an empty inactive live snapshot were published', async () => {
        const file = new File(['payload'], 'notes.txt', { type: 'text/plain' })
        saveDraft('session-source', 'draft before archive')
        saveDraftAttachments('session-source', [{ id: 'a1', file }])

        // Regression guard for the prior bug: empty live snapshot shadows IndexedDB.
        setComposerDraftSnapshot('session-source', 'draft before archive', [])
        await transferComposerDraft('session-source', 'session-reopened')
        expect(await getDraftAttachments('session-reopened')).toEqual([])

        // Clearing the empty snapshot restores the persisted-file path used after archive.
        saveDraft('session-source', 'draft before archive')
        saveDraftAttachments('session-source', [{ id: 'a1', file }])
        clearComposerDraftSnapshot('session-source')
        await transferComposerDraft('session-source', 'session-reopened')
        expect((await getDraftAttachments('session-reopened')).map((item) => item.name)).toEqual(['notes.txt'])
    })
})
