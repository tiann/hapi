import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('seedComposerDraftIfEmpty', () => {
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

    it('seeds the draft when the session has none yet', async () => {
        const { seedComposerDraftIfEmpty } = await import('./seedComposerDraft')
        const { getDraft } = await import('./composer-drafts')
        seedComposerDraftIfEmpty('session-1', 'Fix the lobby carpet')
        expect(getDraft('session-1')).toBe('Fix the lobby carpet')
    })

    it('does not overwrite an existing unsent draft (Codex review: duplicate-merge/import can target a session with one already)', async () => {
        const { seedComposerDraftIfEmpty } = await import('./seedComposerDraft')
        const { getDraft, saveDraft } = await import('./composer-drafts')
        saveDraft('session-1', 'something the user already typed')
        seedComposerDraftIfEmpty('session-1', 'Fix the lobby carpet')
        expect(getDraft('session-1')).toBe('something the user already typed')
    })

    it('does nothing for a blank or whitespace-only message', async () => {
        const { seedComposerDraftIfEmpty } = await import('./seedComposerDraft')
        const { getDraft } = await import('./composer-drafts')
        seedComposerDraftIfEmpty('session-1', '   ')
        seedComposerDraftIfEmpty('session-1', null)
        seedComposerDraftIfEmpty('session-1', undefined)
        expect(getDraft('session-1')).toBe('')
    })
})
