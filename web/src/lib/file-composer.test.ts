import { beforeEach, describe, expect, it } from 'vitest'
import { formatFileReference, appendFileReferenceToComposerDraft } from './file-composer'
import { getDraft, saveDraft } from '@/lib/composer-drafts'
import { getComposerDraftRevision, resetComposerSendStateForTests } from '@/lib/composer-send-state'

describe('file-composer', () => {
    beforeEach(() => {
        window.sessionStorage.clear()
        resetComposerSendStateForTests()
    })

    it('formats a backticked reference', () => {
        expect(formatFileReference('src/foo.ts')).toBe('`src/foo.ts`')
    })

    it('writes a new draft when none exists and increments composer draft revision', () => {
        expect(getComposerDraftRevision('file-composer-empty')).toBe(0)
        appendFileReferenceToComposerDraft('file-composer-empty', 'src/foo.ts')
        expect(getDraft('file-composer-empty')).toBe('`src/foo.ts`')
        expect(getComposerDraftRevision('file-composer-empty')).toBe(1)
    })

    it('appends on a new line and preserves existing text', () => {
        saveDraft('file-composer-existing', 'please review')
        appendFileReferenceToComposerDraft('file-composer-existing', 'src/foo.ts')
        expect(getDraft('file-composer-existing')).toBe('please review\n`src/foo.ts`')
    })

    it('trims trailing whitespace before appending', () => {
        saveDraft('file-composer-trailing', 'please review\n\n')
        appendFileReferenceToComposerDraft('file-composer-trailing', 'src/foo.ts')
        expect(getDraft('file-composer-trailing')).toBe('please review\n`src/foo.ts`')
    })
})
