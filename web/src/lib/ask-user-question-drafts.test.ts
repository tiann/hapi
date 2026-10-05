import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AskUserQuestionDraft } from './ask-user-question-drafts'

const blankDraft: AskUserQuestionDraft = {
    step: 0,
    selectedByQuestion: [[]],
    otherSelectedByQuestion: [false],
    otherTextByQuestion: [''],
    fallbackText: '',
}

const filledDraft: AskUserQuestionDraft = {
    step: 1,
    selectedByQuestion: [[0], []],
    otherSelectedByQuestion: [false, true],
    otherTextByQuestion: ['', 'custom answer'],
    fallbackText: '',
}

describe('ask-user-question-drafts', () => {
    let storage: Record<string, string>

    beforeEach(() => {
        storage = {}
        vi.stubGlobal('sessionStorage', {
            getItem: vi.fn((key: string) => storage[key] ?? null),
            setItem: vi.fn((key: string, value: string) => { storage[key] = value }),
            removeItem: vi.fn((key: string) => { delete storage[key] }),
        })
        vi.resetModules()
    })

    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it('returns null for an unknown key', async () => {
        const mod = await import('./ask-user-question-drafts')
        expect(mod.getAskUserQuestionDraft('unknown')).toBeNull()
    })

    it('keys drafts by session and tool call together', async () => {
        const mod = await import('./ask-user-question-drafts')
        expect(mod.askUserQuestionDraftKey('session-1', 'tool-1')).toBe('session-1:tool-1')
    })

    it('saves and retrieves a draft', async () => {
        const mod = await import('./ask-user-question-drafts')
        mod.saveAskUserQuestionDraft('session-1:tool-1', filledDraft)
        expect(mod.getAskUserQuestionDraft('session-1:tool-1')).toEqual(filledDraft)
    })

    it('persists drafts to sessionStorage', async () => {
        const mod = await import('./ask-user-question-drafts')
        mod.saveAskUserQuestionDraft('session-1:tool-1', filledDraft)
        const stored = JSON.parse(storage['hapi:ask-user-question-drafts'] ?? '{}')
        expect(stored['session-1:tool-1']).toEqual(filledDraft)
    })

    it('clears a draft', async () => {
        const mod = await import('./ask-user-question-drafts')
        mod.saveAskUserQuestionDraft('session-1:tool-1', filledDraft)
        mod.clearAskUserQuestionDraft('session-1:tool-1')
        expect(mod.getAskUserQuestionDraft('session-1:tool-1')).toBeNull()
    })

    it('does not store a draft that is still blank', async () => {
        const mod = await import('./ask-user-question-drafts')
        mod.saveAskUserQuestionDraft('session-1:tool-1', blankDraft)
        expect(mod.getAskUserQuestionDraft('session-1:tool-1')).toBeNull()
        const stored = JSON.parse(storage['hapi:ask-user-question-drafts'] ?? '{}')
        expect(stored).not.toHaveProperty('session-1:tool-1')
    })

    it('deletes an existing entry when overwritten with a blank draft', async () => {
        const mod = await import('./ask-user-question-drafts')
        mod.saveAskUserQuestionDraft('session-1:tool-1', filledDraft)
        mod.saveAskUserQuestionDraft('session-1:tool-1', blankDraft)
        expect(mod.getAskUserQuestionDraft('session-1:tool-1')).toBeNull()
    })

    it('keeps different tool calls in the same session independent', async () => {
        const mod = await import('./ask-user-question-drafts')
        mod.saveAskUserQuestionDraft('session-1:tool-1', filledDraft)
        expect(mod.getAskUserQuestionDraft('session-1:tool-2')).toBeNull()
        expect(mod.getAskUserQuestionDraft('session-1:tool-1')).toEqual(filledDraft)
    })

    it('hydrates from existing sessionStorage data', async () => {
        storage['hapi:ask-user-question-drafts'] = JSON.stringify({ 'session-1:tool-1': filledDraft })
        const mod = await import('./ask-user-question-drafts')
        expect(mod.getAskUserQuestionDraft('session-1:tool-1')).toEqual(filledDraft)
    })

    it('recovers from invalid sessionStorage data', async () => {
        storage['hapi:ask-user-question-drafts'] = 'not valid json'
        const mod = await import('./ask-user-question-drafts')
        expect(mod.getAskUserQuestionDraft('any')).toBeNull()
        mod.saveAskUserQuestionDraft('any', filledDraft)
        expect(mod.getAskUserQuestionDraft('any')).toEqual(filledDraft)
    })

    it('ignores malformed entries during hydration', async () => {
        storage['hapi:ask-user-question-drafts'] = JSON.stringify({
            'valid:tool': filledDraft,
            'invalid:missing-fields': { step: 0 },
            'invalid:not-an-object': 'oops',
        })
        const mod = await import('./ask-user-question-drafts')
        expect(mod.getAskUserQuestionDraft('valid:tool')).toEqual(filledDraft)
        expect(mod.getAskUserQuestionDraft('invalid:missing-fields')).toBeNull()
        expect(mod.getAskUserQuestionDraft('invalid:not-an-object')).toBeNull()
    })

    it('evicts oldest entries when exceeding MAX_DRAFTS', async () => {
        const mod = await import('./ask-user-question-drafts')
        for (let i = 0; i < 55; i++) {
            mod.saveAskUserQuestionDraft(`session-${i}:tool`, filledDraft)
        }
        for (let i = 0; i < 5; i++) {
            expect(mod.getAskUserQuestionDraft(`session-${i}:tool`)).toBeNull()
        }
        for (let i = 5; i < 55; i++) {
            expect(mod.getAskUserQuestionDraft(`session-${i}:tool`)).toEqual(filledDraft)
        }
    })
})
