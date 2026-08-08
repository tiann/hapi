import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    getDraft: vi.fn(),
    saveDraft: vi.fn(),
    clearDraft: vi.fn(),
    getDraftAttachments: vi.fn(),
    getRestoredUploadMetadata: vi.fn(),
    saveDraftAttachments: vi.fn(),
    moveDraftAttachments: vi.fn(async (
        _source: string,
        _target: string,
        resolveAttachments: () => Array<{ id: string; file: File }>,
    ) => resolveAttachments()),
}))

vi.mock('@/lib/composer-drafts', () => ({
    getDraft: mocks.getDraft,
    saveDraft: mocks.saveDraft,
    clearDraft: mocks.clearDraft,
}))
vi.mock('@/lib/composer-attachment-drafts', () => ({
    getDraftAttachments: mocks.getDraftAttachments,
    getRestoredUploadMetadata: mocks.getRestoredUploadMetadata,
    saveDraftAttachments: mocks.saveDraftAttachments,
    moveDraftAttachments: mocks.moveDraftAttachments,
}))

import {
    attachmentDraftRevision,
    clearComposerDraftSnapshot,
    composerDraftWasHandedOff,
    forgetComposerDraftHandoff,
    handoffComposerDraft,
    persistInactiveComposerAttachments,
    setComposerDraftSnapshot,
    transferComposerDraft,
    transferComposerDraftThenNavigate,
    updateComposerDraftTextSnapshot,
} from './composer-draft-transfer'

function resetSession(sessionId: string): void {
    clearComposerDraftSnapshot(sessionId)
    forgetComposerDraftHandoff(sessionId)
}

function resetMoveDraftMock(): void {
    mocks.moveDraftAttachments.mockReset()
    mocks.moveDraftAttachments.mockImplementation(async (
        _source: string,
        _target: string,
        resolveAttachments: () => Array<{ id: string; file: File }>,
    ) => resolveAttachments())
}

function expectMovedAttachments(
    sourceSessionId: string,
    targetSessionId: string,
    expected: unknown,
): void {
    expect(mocks.moveDraftAttachments).toHaveBeenCalledWith(
        sourceSessionId,
        targetSessionId,
        expect.any(Function),
    )
    const resolve = mocks.moveDraftAttachments.mock.calls.find(
        (call) => call[0] === sourceSessionId && call[1] === targetSessionId,
    )?.[2] as (() => unknown) | undefined
    expect(resolve?.()).toEqual(expected)
}

describe('transferComposerDraft', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        resetMoveDraftMock()
        resetSession('old-live')
        resetSession('new-live')
        resetSession('old-stored')
        resetSession('new-stored')
        resetSession('old-empty')
        resetSession('new-empty')
        resetSession('old-pending')
        resetSession('new-pending')
        resetSession('source-a')
        resetSession('target-a')
    })

    it('prefers the live composer snapshot when reopening the visible session', async () => {
        const file = new File(['draft'], 'draft.txt')
        setComposerDraftSnapshot('old-live', 'latest text', [{ id: 'a1', file }])

        await transferComposerDraft('old-live', 'new-live')

        expect(mocks.saveDraft).toHaveBeenCalledWith('new-live', 'latest text')
        expectMovedAttachments('old-live', 'new-live', [{ id: 'a1', file }])
        expect(mocks.clearDraft).toHaveBeenCalledWith('old-live')
        expect(mocks.saveDraftAttachments).not.toHaveBeenCalled()
        expect(mocks.getDraftAttachments).not.toHaveBeenCalled()
        expect(composerDraftWasHandedOff('old-live')).toBe(true)
    })

    it('drops session-scoped upload metadata for a session-list reopen', async () => {
        const file = new File(['draft'], 'draft.txt')
        mocks.getDraft.mockReturnValue('persisted text')
        mocks.getDraftAttachments.mockResolvedValue([file])
        mocks.getRestoredUploadMetadata.mockReturnValue({
            id: 'uploaded-1',
            path: '/tmp/uploaded-1',
            previewUrl: 'blob:preview',
            uploadSessionId: 'old-stored',
        })

        await transferComposerDraft('old-stored', 'new-stored')

        expect(mocks.saveDraft).toHaveBeenCalledWith('new-stored', 'persisted text')
        expectMovedAttachments('old-stored', 'new-stored', [{
            id: 'uploaded-1',
            file,
            path: undefined,
            previewUrl: undefined,
            uploadSessionId: undefined,
        }])
        expect(mocks.clearDraft).toHaveBeenCalledWith('old-stored')
    })

    it('does not resurrect persisted text when the live composer is empty', async () => {
        mocks.getDraft.mockReturnValue('stale persisted text')
        setComposerDraftSnapshot('old-empty', '', [])

        await transferComposerDraft('old-empty', 'new-empty')

        expect(mocks.saveDraft).toHaveBeenCalledWith('new-empty', '')
        expectMovedAttachments('old-empty', 'new-empty', [])
    })

    it('falls back to persisted attachments after an inactive empty live snapshot is cleared', async () => {
        const file = new File(['kept'], 'kept.txt')
        mocks.getDraft.mockReturnValue('typed while inactive')
        mocks.getDraftAttachments.mockResolvedValue([file])
        mocks.getRestoredUploadMetadata.mockReturnValue({
            id: 'kept-1',
            path: '/tmp/kept',
            uploadSessionId: 'old-empty',
        })
        setComposerDraftSnapshot('old-empty', 'typed while inactive', [])
        clearComposerDraftSnapshot('old-empty')

        await transferComposerDraft('old-empty', 'new-empty')

        expect(mocks.saveDraft).toHaveBeenCalledWith('new-empty', 'typed while inactive')
        expectMovedAttachments('old-empty', 'new-empty', [{
            id: 'kept-1',
            file,
            path: undefined,
            previewUrl: undefined,
            uploadSessionId: undefined,
        }])
    })

    it('merges an in-flight pending attachment that is not in the live snapshot yet', async () => {
        const existing = new File(['old'], 'old.txt')
        const pending = new File(['new'], 'new.txt')
        setComposerDraftSnapshot('old-pending', 'typed', [{ id: 'a1', file: existing }])

        await transferComposerDraft('old-pending', 'new-pending', [{
            id: 'a2',
            file: pending,
            previewUrl: 'data:text/plain;base64,bmV3',
        }])

        expectMovedAttachments('old-pending', 'new-pending', [
            { id: 'a1', file: existing },
            {
                id: 'a2',
                file: pending,
                previewUrl: 'data:text/plain;base64,bmV3',
                path: undefined,
                uploadSessionId: undefined,
            },
        ])
    })

    it('does not let a previously visited target snapshot replace the source draft', async () => {
        const sourceFile = new File(['source'], 'source.txt')
        const staleTargetFile = new File(['stale'], 'stale.txt')
        mocks.getDraft.mockImplementation((sessionId: string) => (
            sessionId === 'old-stored' ? 'source text' : 'stale target text'
        ))
        mocks.getDraftAttachments.mockImplementation(async (sessionId: string) => (
            sessionId === 'old-stored' ? [sourceFile] : [staleTargetFile]
        ))
        mocks.getRestoredUploadMetadata.mockImplementation((file: File) => (
            file === sourceFile
                ? { id: 'source-1', path: '/tmp/source', uploadSessionId: 'old-stored' }
                : { id: 'stale-1', path: '/tmp/stale', uploadSessionId: 'new-stored' }
        ))
        setComposerDraftSnapshot('new-stored', 'visited earlier', [{ id: 'stale-1', file: staleTargetFile }])

        await transferComposerDraft('old-stored', 'new-stored')

        expect(mocks.saveDraft).toHaveBeenCalledWith('new-stored', 'source text')
        expectMovedAttachments('old-stored', 'new-stored', [{
            id: 'source-1',
            file: sourceFile,
            path: undefined,
            previewUrl: undefined,
            uploadSessionId: undefined,
        }])
    })

    it('blocks source re-persist after a durable handoff', async () => {
        const file = new File(['draft'], 'draft.txt')
        setComposerDraftSnapshot('old-live', 'latest text', [{ id: 'a1', file }])

        await transferComposerDraft('old-live', 'new-live')
        await persistInactiveComposerAttachments('old-live', 'resurrect?', [{ id: 'a1', file }])

        expect(composerDraftWasHandedOff('old-live')).toBe(true)
        expect(mocks.saveDraftAttachments).not.toHaveBeenCalled()
    })
})

describe('handoffComposerDraft', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        resetMoveDraftMock()
        resetSession('source-a')
        resetSession('target-a')
        mocks.getDraft.mockReturnValue('hello')
        mocks.getDraftAttachments.mockResolvedValue([])
    })

    it('passes every concurrent in-flight file into one navigable handoff', async () => {
        const file1 = new File(['one'], 'one.txt')
        const file2 = new File(['two'], 'two.txt')
        const onNavigable = vi.fn().mockResolvedValue(undefined)

        const first = handoffComposerDraft('source-a', 'target-a', { id: 'p1', file: file1 }, onNavigable)
        const second = handoffComposerDraft('source-a', 'target-a', { id: 'p2', file: file2 }, onNavigable)

        await Promise.all([first, second])

        expect(onNavigable).toHaveBeenCalledOnce()
        expect(onNavigable).toHaveBeenCalledWith('target-a')
        const resolve = mocks.moveDraftAttachments.mock.calls.at(-1)?.[2] as (() => Array<{ id: string }>)
        expect(resolve().map((item) => item.id).sort()).toEqual(['p1', 'p2'])
    })

    it('appends a staggered file onto the target after the first handoff completes', async () => {
        const file1 = new File(['one'], 'one.txt')
        const file2 = new File(['two'], 'two.txt')
        const onNavigable = vi.fn().mockResolvedValue(undefined)

        await handoffComposerDraft('source-a', 'target-a', { id: 'p1', file: file1 }, onNavigable)
        await handoffComposerDraft('source-a', 'target-a', { id: 'p2', file: file2 }, onNavigable)

        expect(onNavigable).toHaveBeenCalledOnce()
        const savedAttachments = mocks.saveDraftAttachments.mock.calls.at(-1)?.[1] as Array<{ id: string }>
        expect(savedAttachments.map((item) => item.id).sort()).toEqual(['p1', 'p2'])
    })

    it('keeps upload metadata when appending onto the same target session', async () => {
        const uploaded = new File(['one'], 'one.txt')
        const late = new File(['two'], 'two.txt')
        const onNavigable = vi.fn().mockResolvedValue(undefined)

        // First handoff establishes source→target mapping.
        await handoffComposerDraft('source-a', 'target-a', { id: 'p1', file: uploaded }, onNavigable)
        // Simulate the target composer having finished uploading p1.
        setComposerDraftSnapshot('target-a', 'hello', [{
            id: 'p1',
            file: uploaded,
            path: '/uploads/one.txt',
            uploadSessionId: 'target-a',
        }])
        await handoffComposerDraft('source-a', 'target-a', { id: 'p2', file: late }, onNavigable)

        const savedAttachments = mocks.saveDraftAttachments.mock.calls.at(-1)?.[1] as Array<{
            id: string
            path?: string
            uploadSessionId?: string
        }>
        expect(savedAttachments).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: 'p1',
                path: '/uploads/one.txt',
                uploadSessionId: 'target-a',
            }),
            expect.objectContaining({ id: 'p2', file: late }),
        ]))
    })

    it('drops a cancelled pending id from the source snapshot at save time', async () => {
        const kept = new File(['kept'], 'kept.txt')
        const cancelled = new File(['gone'], 'gone.txt')
        setComposerDraftSnapshot('source-a', 'typed', [
            { id: 'kept-1', file: kept },
            { id: 'gone-1', file: cancelled },
        ])
        const onNavigable = vi.fn().mockResolvedValue(undefined)

        await handoffComposerDraft(
            'source-a',
            'target-a',
            {
                id: 'gone-1',
                file: cancelled,
                isCancelled: () => true,
            },
            onNavigable,
        )

        expect(onNavigable).toHaveBeenCalledOnce()
        expectMovedAttachments('source-a', 'target-a', [
            expect.objectContaining({ id: 'kept-1', file: kept }),
        ])
    })

    it('re-samples isCancelled after an async gap before writing the transfer', async () => {
        const kept = new File(['kept'], 'kept.txt')
        const cancelled = new File(['gone'], 'gone.txt')
        setComposerDraftSnapshot('source-a', 'typed', [
            { id: 'kept-1', file: kept },
            { id: 'gone-1', file: cancelled },
        ])
        let cancelledNow = false
        const onNavigable = vi.fn().mockResolvedValue(undefined)

        const handoff = handoffComposerDraft(
            'source-a',
            'target-a',
            {
                id: 'gone-1',
                file: cancelled,
                isCancelled: () => cancelledNow,
            },
            onNavigable,
        )
        // Cancel after enqueue, before the handoff's setTimeout(0) transfer samples.
        cancelledNow = true
        await handoff

        expect(onNavigable).toHaveBeenCalledOnce()
        expectMovedAttachments('source-a', 'target-a', [
            expect.objectContaining({ id: 'kept-1', file: kept }),
        ])
    })

    it('re-samples cancellation after the mocked draft-write drain', async () => {
        const kept = new File(['kept'], 'kept.txt')
        const cancelled = new File(['gone'], 'gone.txt')
        setComposerDraftSnapshot('source-a', 'typed', [
            { id: 'kept-1', file: kept },
            { id: 'gone-1', file: cancelled },
        ])
        let cancelledNow = false
        let releaseDrain!: () => void
        const drainGate = new Promise<void>((resolve) => {
            releaseDrain = resolve
        })
        mocks.moveDraftAttachments.mockImplementation(async (
            _source: string,
            _target: string,
            resolveAttachments: () => Array<{ id: string; file: File }>,
        ) => {
            await drainGate
            return resolveAttachments()
        })

        const transfer = transferComposerDraft('source-a', 'target-a', [{
            id: 'gone-1',
            file: cancelled,
            isCancelled: () => cancelledNow,
        }])
        cancelledNow = true
        releaseDrain()
        await transfer

        expectMovedAttachments('source-a', 'target-a', [
            expect.objectContaining({ id: 'kept-1', file: kept }),
        ])
        expect(composerDraftWasHandedOff('source-a')).toBe(true)
    })

    it('re-samples composer text after the awaited attachment move', async () => {
        const file = new File(['draft'], 'draft.txt')
        setComposerDraftSnapshot('source-a', 'before wait', [{ id: 'a1', file }])
        let releaseDrain!: () => void
        const drainGate = new Promise<void>((resolve) => {
            releaseDrain = resolve
        })
        mocks.moveDraftAttachments.mockImplementation(async (
            _source: string,
            _target: string,
            resolveAttachments: () => Array<{ id: string; file: File }>,
        ) => {
            await drainGate
            return resolveAttachments()
        })

        const transfer = transferComposerDraft('source-a', 'target-a')
        updateComposerDraftTextSnapshot('source-a', 'typed during wait')
        releaseDrain()
        await transfer

        expect(mocks.saveDraft).toHaveBeenCalledWith('target-a', 'typed during wait')
        expect(composerDraftWasHandedOff('source-a')).toBe(true)
    })

    it('prefers the send-time textOverride over a cleared inactive draft', async () => {
        const file = new File(['draft'], 'draft.txt')
        setComposerDraftSnapshot('source-a', 'submitted hello', [{ id: 'a1', file }])
        let releaseDrain!: () => void
        const drainGate = new Promise<void>((resolve) => {
            releaseDrain = resolve
        })
        mocks.moveDraftAttachments.mockImplementation(async (
            _source: string,
            _target: string,
            resolveAttachments: () => Array<{ id: string; file: File }>,
        ) => {
            await drainGate
            return resolveAttachments()
        })

        const transfer = transferComposerDraft(
            'source-a',
            'target-a',
            [],
            { textOverride: 'submitted hello' },
        )
        // assistant-ui cleared the composer while resumeSession awaited.
        updateComposerDraftTextSnapshot('source-a', '')
        releaseDrain()
        await transfer

        expect(mocks.saveDraft).toHaveBeenCalledWith('target-a', 'submitted hello')
        expect(composerDraftWasHandedOff('source-a')).toBe(true)
    })

    it('applies textOverride on same-id resume when attachments stay put', async () => {
        mocks.getDraft.mockReturnValue('')
        await transferComposerDraft(
            'session-same',
            'session-same',
            [],
            { textOverride: 'submitted hello' },
        )
        expect(mocks.saveDraft).toHaveBeenCalledWith('session-same', 'submitted hello')
        expect(mocks.moveDraftAttachments).not.toHaveBeenCalled()
    })

    it('keeps IndexedDB-only attachments when typing during a blocked move', async () => {
        const stored = new File(['kept'], 'kept.txt')
        mocks.getDraft.mockReturnValue('before')
        mocks.getDraftAttachments.mockResolvedValue([stored])
        mocks.getRestoredUploadMetadata.mockReturnValue({ id: 'stored-1' })
        let releaseDrain!: () => void
        const drainGate = new Promise<void>((resolve) => {
            releaseDrain = resolve
        })
        let movedDuringDrain: Array<{ id: string; file: File }> | undefined
        mocks.moveDraftAttachments.mockImplementation(async (
            source: string,
            target: string,
            resolveAttachments: () => Array<{ id: string; file: File }>,
        ) => {
            if (source === target) {
                return resolveAttachments()
            }
            await drainGate
            movedDuringDrain = resolveAttachments()
            return movedDuringDrain
        })

        const transfer = transferComposerDraft('source-a', 'target-a')
        // Let transfer install the barrier and enter the blocked move.
        await Promise.resolve()
        await Promise.resolve()
        updateComposerDraftTextSnapshot('source-a', 'typed during wait')
        releaseDrain()
        await transfer

        expect(mocks.saveDraft).toHaveBeenCalledWith('target-a', 'typed during wait')
        expect(movedDuringDrain).toEqual([
            expect.objectContaining({ id: 'stored-1', file: stored }),
        ])
        expect(composerDraftWasHandedOff('source-a')).toBe(true)
    })

    it('drops attachments cancelled while the durable move is in flight', async () => {
        const kept = new File(['kept'], 'kept.txt')
        const doomed = new File(['doomed'], 'doomed.txt')
        setComposerDraftSnapshot('source-a', 'typed', [{ id: 'kept-1', file: kept }])
        let cancelled = false
        let releaseMove!: () => void
        const moveGate = new Promise<void>((resolve) => {
            releaseMove = resolve
        })
        mocks.moveDraftAttachments.mockImplementation(async (
            source: string,
            target: string,
            resolveAttachments: () => Array<{ id: string; file: File }>,
        ) => {
            if (source === target) {
                return resolveAttachments()
            }
            const resolved = resolveAttachments()
            await moveGate
            return resolved
        })

        const transfer = transferComposerDraft('source-a', 'target-a', [
            { id: 'doomed-1', file: doomed, isCancelled: () => cancelled },
        ])
        await Promise.resolve()
        await Promise.resolve()
        cancelled = true
        releaseMove()
        await transfer

        const correctiveResolvers = mocks.moveDraftAttachments.mock.calls
            .filter((call) => call[0] === call[1])
            .map((call) => call[2] as () => Array<{ id: string }>)
        expect(correctiveResolvers.length).toBeGreaterThanOrEqual(1)
        expect(correctiveResolvers.at(-1)?.().map((item) => item.id)).toEqual(['kept-1'])
        expect(composerDraftWasHandedOff('source-a')).toBe(true)
    })

    it('stabilizes multi-file cancellation across the corrective write', async () => {
        const fileA = new File(['a'], 'a.txt')
        const fileB = new File(['b'], 'b.txt')
        setComposerDraftSnapshot('source-a', 'typed', [])
        let cancelA = false
        let cancelB = false
        let correctiveCalls = 0
        let releaseCorrective!: () => void
        const correctiveGate = new Promise<void>((resolve) => {
            releaseCorrective = resolve
        })
        mocks.moveDraftAttachments.mockImplementation(async (
            source: string,
            target: string,
            resolveAttachments: () => Array<{ id: string; file: File }>,
        ) => {
            if (source === target) {
                correctiveCalls += 1
                if (correctiveCalls === 1) {
                    await correctiveGate
                }
                return resolveAttachments()
            }
            const resolved = resolveAttachments()
            cancelA = true
            return resolved
        })

        const transfer = transferComposerDraft('source-a', 'target-a', [
            { id: 'a1', file: fileA, isCancelled: () => cancelA },
            { id: 'b1', file: fileB, isCancelled: () => cancelB },
        ])
        await Promise.resolve()
        await Promise.resolve()
        // First corrective is blocked; cancel the sibling mid-write.
        cancelB = true
        releaseCorrective()
        await transfer

        expect(correctiveCalls).toBeGreaterThanOrEqual(2)
        const lastCorrective = mocks.moveDraftAttachments.mock.calls
            .filter((call) => call[0] === call[1])
            .at(-1)?.[2] as (() => Array<{ id: string }>) | undefined
        expect(lastCorrective?.().map((item) => item.id)).toEqual([])
        expect(composerDraftWasHandedOff('source-a')).toBe(true)
    })

    it('does not move when the source IndexedDB attachment read fails', async () => {
        clearComposerDraftSnapshot('source-a')
        forgetComposerDraftHandoff('source-a')
        mocks.getDraft.mockReturnValue('typed')
        mocks.getDraftAttachments.mockRejectedValue(new Error('IndexedDB read failed'))

        await expect(transferComposerDraft('source-a', 'target-a')).rejects.toThrow(/IndexedDB read failed/)

        expect(mocks.moveDraftAttachments).not.toHaveBeenCalled()
        expect(mocks.clearDraft).not.toHaveBeenCalled()
        expect(composerDraftWasHandedOff('source-a')).toBe(false)
        // Text is independently recoverable under the resumed id even when
        // attachment storage fails closed.
        expect(mocks.saveDraft).toHaveBeenCalledWith('target-a', 'typed')
    })

    it('still leaves target text after navigate when attachment read fails', async () => {
        clearComposerDraftSnapshot('source-a')
        forgetComposerDraftHandoff('source-a')
        mocks.getDraft.mockReturnValue('typed')
        mocks.getDraftAttachments.mockRejectedValue(new Error('IndexedDB read failed'))
        const navigate = vi.fn().mockResolvedValue(undefined)

        await transferComposerDraftThenNavigate('source-a', 'target-a', navigate)

        expect(navigate).toHaveBeenCalledOnce()
        expect(mocks.saveDraft).toHaveBeenCalledWith('target-a', 'typed')
        expect(mocks.moveDraftAttachments).not.toHaveBeenCalled()
    })

    it('still navigates when the local durable move rejects', async () => {
        const file = new File(['draft'], 'draft.txt')
        setComposerDraftSnapshot('source-a', 'typed', [{ id: 'a1', file }])
        mocks.moveDraftAttachments.mockRejectedValue(new Error('quota exceeded'))
        const onNavigable = vi.fn().mockResolvedValue(undefined)

        await handoffComposerDraft(
            'source-a',
            'target-a',
            { id: 'p1', file },
            onNavigable,
        )

        expect(onNavigable).toHaveBeenCalledWith('target-a')
        expect(composerDraftWasHandedOff('source-a')).toBe(false)
        expect(mocks.saveDraft).toHaveBeenCalledWith('target-a', 'typed')
    })

    it('navigates after resume even when transferComposerDraftThenNavigate hits a move failure', async () => {
        const file = new File(['draft'], 'draft.txt')
        setComposerDraftSnapshot('source-a', 'typed', [{ id: 'a1', file }])
        mocks.moveDraftAttachments.mockRejectedValue(new Error('quota exceeded'))
        const navigate = vi.fn().mockResolvedValue(undefined)

        await transferComposerDraftThenNavigate('source-a', 'target-a', navigate)

        expect(navigate).toHaveBeenCalledOnce()
        expect(composerDraftWasHandedOff('source-a')).toBe(false)
    })
})

describe('updateComposerDraftTextSnapshot', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        resetMoveDraftMock()
        resetSession('session-inactive')
    })

    it('updates text without writing attachment blobs', () => {
        const file = new File(['blob'], 'big.bin')
        setComposerDraftSnapshot('session-inactive', 'before', [{ id: 'a1', file }])

        updateComposerDraftTextSnapshot('session-inactive', 'after keystroke')

        expect(mocks.saveDraft).toHaveBeenCalledWith('session-inactive', 'after keystroke')
        expect(mocks.saveDraftAttachments).not.toHaveBeenCalled()
    })

    it('keeps attachment revision stable across text-only changes', () => {
        const file = new File(['blob'], 'big.bin')
        const drafts = [{ id: 'a1', file, path: '/tmp/a', uploadSessionId: 's1' }]
        expect(attachmentDraftRevision(drafts)).toBe(attachmentDraftRevision([
            { id: 'a1', file: new File(['other'], 'other.bin'), path: '/tmp/a', uploadSessionId: 's1' },
        ]))
        expect(attachmentDraftRevision(drafts)).not.toBe(attachmentDraftRevision([
            { id: 'a1', file, path: '/tmp/b', uploadSessionId: 's1' },
        ]))
    })
})

describe('persistInactiveComposerAttachments', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        resetMoveDraftMock()
        resetSession('session-inactive')
        resetSession('old-pending')
        resetSession('new-pending')
    })

    it('clears the live snapshot without touching stored files when nothing is visible', async () => {
        setComposerDraftSnapshot('session-inactive', 'stale', [])
        mocks.getDraftAttachments.mockResolvedValue([new File(['kept'], 'kept.txt')])

        await persistInactiveComposerAttachments('session-inactive', 'typed', [])

        expect(mocks.saveDraft).toHaveBeenCalledWith('session-inactive', 'typed')
        expect(mocks.saveDraftAttachments).not.toHaveBeenCalled()
    })

    it('does not publish a partial snapshot when the merge read fails', async () => {
        const picked = new File(['b'], 'b.txt')
        mocks.getDraftAttachments.mockImplementation(async (
            _sessionId: string,
            options?: { throwOnError?: boolean },
        ) => {
            if (options?.throwOnError) throw new Error('idb merge read failed')
            return []
        })

        await expect(persistInactiveComposerAttachments('old-pending', 'typed', [
            { id: 'b1', file: picked },
        ])).rejects.toThrow(/idb merge read failed/)

        expect(mocks.saveDraftAttachments).not.toHaveBeenCalled()
        expect(mocks.getDraftAttachments).toHaveBeenCalledWith('old-pending', { throwOnError: true })

        // Transfer must not see a live-only-B snapshot and skip the strict read.
        mocks.getDraft.mockReturnValue('typed')
        await expect(transferComposerDraft('old-pending', 'new-pending')).rejects.toThrow()
        expect(mocks.moveDraftAttachments).not.toHaveBeenCalled()
        expect(composerDraftWasHandedOff('old-pending')).toBe(false)
    })

    it('merges a newly selected file into the hidden stored draft', async () => {
        const stored = new File(['a'], 'a.txt')
        const picked = new File(['b'], 'b.txt')
        mocks.getDraftAttachments.mockResolvedValue([stored])
        mocks.getRestoredUploadMetadata.mockReturnValue({
            id: 'stored-a',
            path: '/tmp/a',
            uploadSessionId: 'session-inactive',
        })

        await persistInactiveComposerAttachments('session-inactive', 'typed', [{
            id: 'picked-b',
            file: picked,
        }])

        expect(mocks.saveDraftAttachments).toHaveBeenCalledWith('session-inactive', [
            expect.objectContaining({ id: 'stored-a', file: stored }),
            expect.objectContaining({ id: 'picked-b', file: picked }),
        ])
    })

    it('removes a previously visible failed pick from storage when the operator clears it', async () => {
        const storedA = new File(['a'], 'a.txt')
        const pickedB = new File(['b'], 'b.txt')
        mocks.getDraftAttachments
            .mockResolvedValueOnce([storedA])
            .mockResolvedValueOnce([storedA, pickedB])
        mocks.getRestoredUploadMetadata.mockImplementation((file: File) => {
            if (file === storedA) {
                return { id: 'stored-a', path: '/tmp/a', uploadSessionId: 'session-inactive' }
            }
            if (file === pickedB) {
                return { id: 'picked-b' }
            }
            return undefined
        })

        await persistInactiveComposerAttachments('session-inactive', 'typed', [{
            id: 'picked-b',
            file: pickedB,
        }])
        await persistInactiveComposerAttachments('session-inactive', 'typed', [])

        expect(mocks.saveDraftAttachments).toHaveBeenLastCalledWith('session-inactive', [
            expect.objectContaining({ id: 'stored-a', file: storedA }),
        ])
    })

    it('serializes concurrent persist calls so an older read cannot overwrite a newer merge', async () => {
        const storedA = new File(['a'], 'a.txt')
        const pickedB = new File(['b'], 'b.txt')
        const pickedC = new File(['c'], 'c.txt')
        let releaseFirstRead!: () => void
        const firstReadGate = new Promise<void>((resolve) => {
            releaseFirstRead = resolve
        })
        let readCount = 0
        mocks.getDraftAttachments.mockImplementation(async () => {
            readCount += 1
            if (readCount === 1) {
                await firstReadGate
                return [storedA]
            }
            return [storedA]
        })
        mocks.getRestoredUploadMetadata.mockReturnValue({
            id: 'stored-a',
            path: '/tmp/a',
            uploadSessionId: 'session-inactive',
        })

        const first = persistInactiveComposerAttachments('session-inactive', 'first', [{
            id: 'picked-b',
            file: pickedB,
        }])
        const second = persistInactiveComposerAttachments('session-inactive', 'second', [{
            id: 'picked-c',
            file: pickedC,
        }])
        releaseFirstRead()
        await Promise.all([first, second])

        expect(mocks.saveDraftAttachments.mock.calls.at(-1)?.[1]).toEqual([
            expect.objectContaining({ id: 'stored-a', file: storedA }),
            expect.objectContaining({ id: 'picked-c', file: pickedC }),
        ])
    })

    it('awaits a pending inactive persist before transferComposerDraft reads storage', async () => {
        const storedA = new File(['a'], 'a.txt')
        const pickedB = new File(['b'], 'b.txt')
        let releaseRead!: () => void
        const readGate = new Promise<void>((resolve) => {
            releaseRead = resolve
        })
        mocks.getDraft.mockReturnValue('typed')
        mocks.getDraftAttachments.mockImplementation(async () => {
            await readGate
            return [storedA]
        })
        mocks.getRestoredUploadMetadata.mockImplementation((file: File) => {
            if (file === storedA) {
                return { id: 'stored-a', path: '/tmp/a' }
            }
            return { id: 'picked-b' }
        })

        const persist = persistInactiveComposerAttachments('old-pending', 'typed', [{
            id: 'picked-b',
            file: pickedB,
        }])
        const transfer = transferComposerDraft('old-pending', 'new-pending')
        releaseRead()
        await Promise.all([persist, transfer])

        expectMovedAttachments('old-pending', 'new-pending', expect.arrayContaining([
            expect.objectContaining({ id: 'stored-a' }),
            expect.objectContaining({ id: 'picked-b' }),
        ]))
    })

    it('routes attachment edits during an in-flight move to the target without recreating the source', async () => {
        const kept = new File(['kept'], 'kept.txt')
        const removed = new File(['gone'], 'gone.txt')
        setComposerDraftSnapshot('old-pending', 'typed', [
            { id: 'kept-1', file: kept },
            { id: 'gone-1', file: removed },
        ])
        let releaseMove!: () => void
        const moveGate = new Promise<void>((resolve) => {
            releaseMove = resolve
        })
        mocks.moveDraftAttachments.mockImplementation(async (_source, _target, resolveAttachments) => {
            await moveGate
            return resolveAttachments()
        })

        const transfer = transferComposerDraft('old-pending', 'new-pending')
        await Promise.resolve()
        await persistInactiveComposerAttachments('old-pending', 'typed', [{ id: 'kept-1', file: kept }])
        releaseMove()
        await transfer

        expect(mocks.saveDraftAttachments.mock.calls.filter((call) => call[0] === 'old-pending')).toEqual([])
        // Late edit triggers an awaited same-target corrective move, not a fire-and-forget save.
        expect(mocks.moveDraftAttachments).toHaveBeenCalledWith(
            'new-pending',
            'new-pending',
            expect.any(Function),
        )
        const corrective = mocks.moveDraftAttachments.mock.calls.find(
            (call) => call[0] === 'new-pending' && call[1] === 'new-pending',
        )?.[2] as (() => Array<{ id: string }>) | undefined
        expect(corrective?.().map((item) => item.id)).toEqual(['kept-1'])
        expect(composerDraftWasHandedOff('old-pending')).toBe(true)
        expect(mocks.clearDraft).toHaveBeenCalledWith('old-pending')
    })

    it('does not mark a durable handoff when the corrective target write rejects', async () => {
        const kept = new File(['kept'], 'kept.txt')
        const removed = new File(['gone'], 'gone.txt')
        setComposerDraftSnapshot('old-pending', 'typed', [
            { id: 'kept-1', file: kept },
            { id: 'gone-1', file: removed },
        ])
        let releaseMove!: () => void
        const moveGate = new Promise<void>((resolve) => {
            releaseMove = resolve
        })
        let correctiveCalls = 0
        mocks.moveDraftAttachments.mockImplementation(async (source, target, resolveAttachments) => {
            if (source === target) {
                correctiveCalls += 1
                throw new Error('quota exceeded')
            }
            await moveGate
            return resolveAttachments()
        })

        const transfer = transferComposerDraft('old-pending', 'new-pending')
        await Promise.resolve()
        await persistInactiveComposerAttachments('old-pending', 'typed', [{ id: 'kept-1', file: kept }])
        releaseMove()
        await expect(transfer).rejects.toThrow(/quota exceeded/)

        expect(correctiveCalls).toBe(1)
        expect(composerDraftWasHandedOff('old-pending')).toBe(false)
        expect(mocks.clearDraft).not.toHaveBeenCalledWith('old-pending')
    })

    it('repeats the corrective target write until late edits stabilize', async () => {
        const kept = new File(['kept'], 'kept.txt')
        setComposerDraftSnapshot('old-pending', 'before', [{ id: 'kept-1', file: kept }])
        let releaseCorrective!: () => void
        const correctiveGate = new Promise<void>((resolve) => {
            releaseCorrective = resolve
        })
        let correctiveCalls = 0
        mocks.moveDraftAttachments.mockImplementation(async (source, target, resolveAttachments) => {
            if (source === target) {
                correctiveCalls += 1
                if (correctiveCalls === 1) {
                    await correctiveGate
                }
                return resolveAttachments()
            }
            return resolveAttachments()
        })

        const transfer = transferComposerDraft('old-pending', 'new-pending')
        await Promise.resolve()
        await persistInactiveComposerAttachments('old-pending', 'mid', [{ id: 'kept-1', file: kept }])
        // First corrective is blocked; a later text edit must force another pass.
        updateComposerDraftTextSnapshot('old-pending', 'final typed')
        releaseCorrective()
        await transfer

        expect(correctiveCalls).toBeGreaterThanOrEqual(2)
        expect(mocks.saveDraft).toHaveBeenCalledWith('new-pending', 'final typed')
        expect(composerDraftWasHandedOff('old-pending')).toBe(true)
    })

    it('buffers a persist that races the first transfer await onto the target', async () => {
        const kept = new File(['kept'], 'kept.txt')
        const removed = new File(['gone'], 'gone.txt')
        setComposerDraftSnapshot('old-pending', 'typed', [
            { id: 'kept-1', file: kept },
            { id: 'gone-1', file: removed },
        ])
        let releasePersistFlush!: () => void
        const persistFlushGate = new Promise<void>((resolve) => {
            releasePersistFlush = resolve
        })
        // Make awaitInactivePersist wait so the barrier is installed first.
        mocks.getDraftAttachments.mockImplementation(async () => {
            await persistFlushGate
            return []
        })
        // Start a no-op queued persist so awaitInactivePersist has work.
        const flushPersist = persistInactiveComposerAttachments('old-pending', 'typed', [
            { id: 'kept-1', file: kept },
            { id: 'gone-1', file: removed },
        ])

        const transfer = transferComposerDraft('old-pending', 'new-pending')
        await Promise.resolve()
        // Barrier is up; this edit must land on pending.latest, not IndexedDB source.
        await persistInactiveComposerAttachments('old-pending', 'typed', [{ id: 'kept-1', file: kept }])
        releasePersistFlush()
        await flushPersist
        await transfer

        expect(mocks.saveDraftAttachments.mock.calls.filter((call) => call[0] === 'old-pending')).toEqual([])
        expectMovedAttachments('old-pending', 'new-pending', [
            expect.objectContaining({ id: 'kept-1', file: kept }),
        ])
    })

    it('does not treat remounted empty visible state as removal of stored failed picks', async () => {
        const { resetInactiveComposerAttachmentVisibility } = await import('./composer-draft-transfer')
        const storedA = new File(['a'], 'a.txt')
        const pickedB = new File(['b'], 'b.txt')
        mocks.getDraftAttachments.mockResolvedValue([storedA, pickedB])
        mocks.getRestoredUploadMetadata.mockImplementation((file: File) => {
            if (file === storedA) return { id: 'stored-a' }
            if (file === pickedB) return { id: 'picked-b' }
            return undefined
        })

        await persistInactiveComposerAttachments('session-inactive', 'typed', [{
            id: 'picked-b',
            file: pickedB,
        }])
        // Remount inactive: visibility tracking resets before the empty hydrate persist.
        resetInactiveComposerAttachmentVisibility('session-inactive')
        mocks.saveDraftAttachments.mockClear()
        await persistInactiveComposerAttachments('session-inactive', 'typed', [])

        expect(mocks.saveDraftAttachments).not.toHaveBeenCalled()
    })
})
