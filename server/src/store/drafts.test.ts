import { describe, expect, it, beforeEach } from 'bun:test'
import { Store } from './index'

describe('Draft Store', () => {
    let store: Store

    beforeEach(() => {
        store = new Store(':memory:')
    })

    describe('getDraft', () => {
        it('returns null for non-existent draft', () => {
            const draft = store.drafts.getDraft('session-1', 'default')
            expect(draft).toBeNull()
        })

        it('returns draft after saving', () => {
            // Create session first (foreign key constraint)
            const session = store.sessions.getOrCreateSession(null, { path: '/test' }, null, 'default')

            store.drafts.setDraft(session.id, 'default', 'Hello world', 1000)

            const draft = store.drafts.getDraft(session.id, 'default')
            expect(draft).toEqual({
                text: 'Hello world',
                timestamp: 1000
            })
        })

        it('filters by namespace', () => {
            // Create sessions in different namespaces
            const sessionAlpha = store.sessions.getOrCreateSession(null, { path: '/alpha' }, null, 'alpha')
            const sessionBeta = store.sessions.getOrCreateSession(null, { path: '/beta' }, null, 'beta')

            store.drafts.setDraft(sessionAlpha.id, 'alpha', 'Draft A', 1000)
            store.drafts.setDraft(sessionBeta.id, 'beta', 'Draft B', 2000)

            const draftAlpha = store.drafts.getDraft(sessionAlpha.id, 'alpha')
            const draftBeta = store.drafts.getDraft(sessionBeta.id, 'beta')

            expect(draftAlpha?.text).toBe('Draft A')
            expect(draftBeta?.text).toBe('Draft B')
        })
    })

    describe('setDraft', () => {
        it('saves draft and returns it', () => {
            const session = store.sessions.getOrCreateSession(null, { path: '/test' }, null, 'default')
            const result = store.drafts.setDraft(session.id, 'default', 'Test draft', 1234567890)

            expect(result).toEqual({
                text: 'Test draft',
                timestamp: 1234567890
            })

            const draft = store.drafts.getDraft(session.id, 'default')
            expect(draft).toEqual(result)
        })

        it('updates draft with newer timestamp', () => {
            const session = store.sessions.getOrCreateSession(null, { path: '/test' }, null, 'default')

            store.drafts.setDraft(session.id, 'default', 'Old draft', 1000)
            const result = store.drafts.setDraft(session.id, 'default', 'New draft', 2000)

            expect(result.text).toBe('New draft')
            expect(result.timestamp).toBe(2000)

            const draft = store.drafts.getDraft(session.id, 'default')
            expect(draft?.text).toBe('New draft')
        })

        it('rejects draft with older timestamp (LWW)', () => {
            const session = store.sessions.getOrCreateSession(null, { path: '/test' }, null, 'default')

            store.drafts.setDraft(session.id, 'default', 'Newer draft', 2000)
            const result = store.drafts.setDraft(session.id, 'default', 'Older draft', 1000)

            // Should return existing draft, not the older one
            expect(result.text).toBe('Newer draft')
            expect(result.timestamp).toBe(2000)

            const draft = store.drafts.getDraft(session.id, 'default')
            expect(draft?.text).toBe('Newer draft')
        })

        it('accepts draft with equal timestamp (LWW accepts >=)', () => {
            const session = store.sessions.getOrCreateSession(null, { path: '/test' }, null, 'default')

            store.drafts.setDraft(session.id, 'default', 'First draft', 1000)
            const result = store.drafts.setDraft(session.id, 'default', 'Second draft', 1000)

            // With equal timestamps, last write wins
            expect(result.text).toBe('Second draft')
            expect(result.timestamp).toBe(1000)
        })

        it('handles multiple sessions independently', () => {
            const session1 = store.sessions.getOrCreateSession(null, { path: '/test1' }, null, 'default')
            const session2 = store.sessions.getOrCreateSession(null, { path: '/test2' }, null, 'default')

            store.drafts.setDraft(session1.id, 'default', 'Draft 1', 1000)
            store.drafts.setDraft(session2.id, 'default', 'Draft 2', 2000)

            const draft1 = store.drafts.getDraft(session1.id, 'default')
            const draft2 = store.drafts.getDraft(session2.id, 'default')

            expect(draft1?.text).toBe('Draft 1')
            expect(draft2?.text).toBe('Draft 2')
        })
    })

    describe('clearDraft', () => {
        it('removes draft from storage', () => {
            const session = store.sessions.getOrCreateSession(null, { path: '/test' }, null, 'default')

            store.drafts.setDraft(session.id, 'default', 'Hello', 1000)
            expect(store.drafts.getDraft(session.id, 'default')).not.toBeNull()

            store.drafts.clearDraft(session.id, 'default')
            expect(store.drafts.getDraft(session.id, 'default')).toBeNull()
        })

        it('only removes specified session draft', () => {
            const session1 = store.sessions.getOrCreateSession(null, { path: '/test1' }, null, 'default')
            const session2 = store.sessions.getOrCreateSession(null, { path: '/test2' }, null, 'default')

            store.drafts.setDraft(session1.id, 'default', 'Draft 1', 1000)
            store.drafts.setDraft(session2.id, 'default', 'Draft 2', 2000)

            store.drafts.clearDraft(session1.id, 'default')

            expect(store.drafts.getDraft(session1.id, 'default')).toBeNull()
            expect(store.drafts.getDraft(session2.id, 'default')).not.toBeNull()
        })

        it('does not throw when clearing non-existent draft', () => {
            expect(() => store.drafts.clearDraft('non-existent', 'default')).not.toThrow()
        })
    })

    describe('CASCADE delete', () => {
        it('deletes draft when session is deleted', () => {
            // Create a session first
            const session = store.sessions.getOrCreateSession(null, { path: '/test' }, null, 'default')

            // Save a draft for that session
            store.drafts.setDraft(session.id, 'default', 'Test draft', 1000)
            expect(store.drafts.getDraft(session.id, 'default')).not.toBeNull()

            // Delete the session
            store.sessions.deleteSession(session.id, 'default')

            // Draft should be automatically deleted via CASCADE
            expect(store.drafts.getDraft(session.id, 'default')).toBeNull()
        })
    })
})
