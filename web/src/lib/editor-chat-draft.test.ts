import { describe, expect, it } from 'vitest'
import { appendEditorChatDraft, buildAddFileToChatText } from './editor-chat-draft'

describe('editor chat draft helpers', () => {
    it('builds an @file token from a path', () => {
        expect(buildAddFileToChatText('/repo/src/App.tsx')).toBe('@/repo/src/App.tsx')
    })

    it('trims path whitespace before building token', () => {
        expect(buildAddFileToChatText('  /repo/src/App.tsx  ')).toBe('@/repo/src/App.tsx')
    })

    it('appends token to an empty draft', () => {
        expect(appendEditorChatDraft('', '/repo/src/App.tsx')).toBe('@/repo/src/App.tsx')
    })

    it('appends token to existing draft on a new line', () => {
        expect(appendEditorChatDraft('Please review', '/repo/src/App.tsx')).toBe('Please review\n@/repo/src/App.tsx')
    })

    it('preserves existing draft text while trimming trailing whitespace before append', () => {
        expect(appendEditorChatDraft('Please review\n', '/repo/src/App.tsx')).toBe('Please review\n@/repo/src/App.tsx')
    })

    it('does not append duplicate file tokens', () => {
        expect(appendEditorChatDraft('Please review\n@/repo/src/App.tsx', '/repo/src/App.tsx')).toBe('Please review\n@/repo/src/App.tsx')
    })

    it('does not treat sibling paths as duplicates', () => {
        expect(appendEditorChatDraft('@/repo/src/App.tsx2', '/repo/src/App.tsx')).toBe('@/repo/src/App.tsx2\n@/repo/src/App.tsx')
    })
})
