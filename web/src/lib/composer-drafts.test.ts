import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('composer-drafts', () => {
    let storage: Record<string, string>

    beforeEach(() => {
        storage = {}
        vi.stubGlobal('sessionStorage', {
            getItem: vi.fn((key: string) => storage[key] ?? null),
            setItem: vi.fn((key: string, value: string) => { storage[key] = value }),
            removeItem: vi.fn((key: string) => { delete storage[key] }),
        })
        // Force re-hydration by clearing the module's internal cache
        // Re-import to reset the lazy-loaded cache
        vi.resetModules()
    })

    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it('returns empty string for unknown session', async () => {
        const mod = await import('./composer-drafts')
        expect(mod.getDraft('unknown-session')).toBe('')
    })

    it('saves and retrieves a draft', async () => {
        const mod = await import('./composer-drafts')
        mod.saveDraft('session-1', 'hello world')
        expect(mod.getDraft('session-1')).toBe('hello world')
    })

    it('persists drafts to sessionStorage', async () => {
        const mod = await import('./composer-drafts')
        mod.saveDraft('session-1', 'test')
        const stored = JSON.parse(storage['hapi:composer-drafts'] ?? '{}')
        expect(stored['session-1']).toBe('test')
    })

    it('clears a draft', async () => {
        const mod = await import('./composer-drafts')
        mod.saveDraft('session-1', 'hello')
        mod.clearDraft('session-1')
        expect(mod.getDraft('session-1')).toBe('')
    })

    it('deletes entry when saving empty or whitespace-only text', async () => {
        const mod = await import('./composer-drafts')
        mod.saveDraft('session-1', 'hello')
        expect(mod.getDraft('session-1')).toBe('hello')

        mod.saveDraft('session-1', '   ')
        expect(mod.getDraft('session-1')).toBe('')

        const stored = JSON.parse(storage['hapi:composer-drafts'] ?? '{}')
        expect(stored).not.toHaveProperty('session-1')
    })

    it('preserves untrimmed text when saving non-empty draft', async () => {
        const mod = await import('./composer-drafts')
        mod.saveDraft('session-1', '  hello  ')
        expect(mod.getDraft('session-1')).toBe('  hello  ')
    })

    it('handles multiple sessions independently', async () => {
        const mod = await import('./composer-drafts')
        mod.saveDraft('session-a', 'text A')
        mod.saveDraft('session-b', 'text B')

        expect(mod.getDraft('session-a')).toBe('text A')
        expect(mod.getDraft('session-b')).toBe('text B')

        mod.clearDraft('session-a')
        expect(mod.getDraft('session-a')).toBe('')
        expect(mod.getDraft('session-b')).toBe('text B')
    })

    it('hydrates from existing sessionStorage data', async () => {
        storage['hapi:composer-drafts'] = JSON.stringify({ 'existing': 'draft text' })
        const mod = await import('./composer-drafts')
        expect(mod.getDraft('existing')).toBe('draft text')
    })

    it('recovers from invalid sessionStorage data', async () => {
        storage['hapi:composer-drafts'] = 'not valid json'
        const mod = await import('./composer-drafts')
        expect(mod.getDraft('any')).toBe('')
        // Should still be able to save
        mod.saveDraft('any', 'recovered')
        expect(mod.getDraft('any')).toBe('recovered')
    })

    it('ignores non-string values during hydration', async () => {
        storage['hapi:composer-drafts'] = JSON.stringify({
            'valid': 'text',
            'invalid-number': 42,
            'invalid-null': null,
        })
        const mod = await import('./composer-drafts')
        expect(mod.getDraft('valid')).toBe('text')
        expect(mod.getDraft('invalid-number')).toBe('')
        expect(mod.getDraft('invalid-null')).toBe('')
    })

    it('refreshes eviction order when updating an existing draft', async () => {
        const mod = await import('./composer-drafts')
        // Save 50 drafts (at capacity)
        for (let i = 0; i < 50; i++) {
            mod.saveDraft(`session-${i}`, `text-${i}`)
        }
        // Update the oldest one (session-0) — should move to end of eviction queue
        mod.saveDraft('session-0', 'updated')
        // Add one more to trigger eviction
        mod.saveDraft('session-50', 'new')
        // session-1 (the new oldest) should be evicted, not session-0
        expect(mod.getDraft('session-0')).toBe('updated')
        expect(mod.getDraft('session-1')).toBe('')
        expect(mod.getDraft('session-50')).toBe('new')
    })

    it('evicts oldest entries when exceeding MAX_DRAFTS', async () => {
        const mod = await import('./composer-drafts')
        // Save 55 drafts (MAX_DRAFTS is 50)
        for (let i = 0; i < 55; i++) {
            mod.saveDraft(`session-${i}`, `text-${i}`)
        }
        // Oldest 5 should be evicted
        for (let i = 0; i < 5; i++) {
            expect(mod.getDraft(`session-${i}`)).toBe('')
        }
        // Remaining 50 should still exist
        for (let i = 5; i < 55; i++) {
            expect(mod.getDraft(`session-${i}`)).toBe(`text-${i}`)
        }
    })
})
