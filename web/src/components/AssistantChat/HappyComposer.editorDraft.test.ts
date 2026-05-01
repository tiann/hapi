import { describe, expect, it } from 'vitest'
import { appendTextToComposerDraft } from './HappyComposer'

describe('appendTextToComposerDraft', () => {
    it('appends added editor context to an empty composer', () => {
        expect(appendTextToComposerDraft('', '@/repo/src/App.tsx')).toBe('@/repo/src/App.tsx')
    })

    it('appends added editor context on a new line without sending it', () => {
        expect(appendTextToComposerDraft('Please inspect', '@/repo/src/App.tsx')).toBe('Please inspect\n@/repo/src/App.tsx')
    })

    it('does not duplicate existing context tokens', () => {
        expect(appendTextToComposerDraft('@/repo/src/App.tsx', '@/repo/src/App.tsx\n@/repo/src/Other.ts')).toBe('@/repo/src/App.tsx\n@/repo/src/Other.ts')
    })
})
