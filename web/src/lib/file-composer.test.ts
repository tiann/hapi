import { beforeEach, describe, expect, it, vi } from 'vitest'

const liveComposers = vi.hoisted(() => new Map<string, { getText: () => string; setText: (text: string) => void }>())
vi.mock('@/hooks/useComposerDraft', () => ({
    getLiveComposerDraft: (sessionId: string) => liveComposers.get(sessionId),
}))

import { formatFileReference, appendFileReferenceToComposerDraft } from './file-composer'
import { getDraft, saveDraft } from '@/lib/composer-drafts'

describe('file-composer', () => {
    beforeEach(() => {
        window.sessionStorage.clear()
        liveComposers.clear()
    })

    it('formats a backticked reference', () => {
        expect(formatFileReference('src/foo.ts')).toBe('`src/foo.ts`')
    })

    it('writes a new draft when none exists', () => {
        appendFileReferenceToComposerDraft('file-composer-empty', 'src/foo.ts')
        expect(getDraft('file-composer-empty')).toBe('`src/foo.ts`')
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

    it('edits a mounted composer instead of only the stored draft', () => {
        let text = 'typed but not saved yet'
        const setText = vi.fn((next: string) => { text = next })
        liveComposers.set('file-composer-live', { getText: () => text, setText })
        saveDraft('file-composer-live', 'stale stored draft')

        appendFileReferenceToComposerDraft('file-composer-live', 'src/foo.ts')

        expect(setText).toHaveBeenCalledWith('typed but not saved yet\n`src/foo.ts`')
        expect(getDraft('file-composer-live')).toBe('typed but not saved yet\n`src/foo.ts`')
    })
})
