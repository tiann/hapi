import { beforeEach, describe, expect, it } from 'vitest'
import {
    clearComposerSnippet,
    getComposerSnippets,
    resetComposerSnippetsCacheForTests,
    saveComposerSnippet
} from './composer-snippets'

const STORAGE_KEY = 'hapi:composer-snippets:v1'

describe('composer snippets storage', () => {
    beforeEach(() => {
        localStorage.clear()
        resetComposerSnippetsCacheForTests()
    })

    it('starts with five empty slots', () => {
        expect(getComposerSnippets()).toEqual([null, null, null, null, null])
    })

    it('saves one fixed snippet and persists it in a fixed slot', () => {
        const saved = saveComposerSnippet(2, '固定提示词', 123)

        expect(saved[2]).toEqual({ id: 'slot-2', text: '固定提示词', updatedAt: 123 })
        resetComposerSnippetsCacheForTests()
        expect(getComposerSnippets()[2]).toEqual({ id: 'slot-2', text: '固定提示词', updatedAt: 123 })
    })

    it('clears a slot when saving blank text', () => {
        saveComposerSnippet(0, 'will clear', 1)
        const next = saveComposerSnippet(0, '   ', 2)

        expect(next[0]).toBeNull()
    })

    it('ignores malformed stored data and clamps to five slots', () => {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            version: 1,
            slots: [
                { id: 'a', text: 'one', updatedAt: 1 },
                { id: 'b', text: 42, updatedAt: 2 },
                null,
                { id: 'd', text: 'four', updatedAt: 'bad' },
                { id: 'e', text: 'five', updatedAt: 5 },
                { id: 'f', text: 'six', updatedAt: 6 }
            ]
        }))
        resetComposerSnippetsCacheForTests()

        expect(getComposerSnippets()).toEqual([
            { id: 'slot-0', text: 'one', updatedAt: 1 },
            null,
            null,
            { id: 'slot-3', text: 'four', updatedAt: 0 },
            { id: 'slot-4', text: 'five', updatedAt: 5 }
        ])
    })

    it('throws on out-of-range slot indexes', () => {
        expect(() => saveComposerSnippet(5, 'nope')).toThrow('Snippet slot index out of range')
        expect(() => clearComposerSnippet(-1)).toThrow('Snippet slot index out of range')
    })
})
