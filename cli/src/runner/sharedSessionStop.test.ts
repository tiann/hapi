import { describe, expect, it } from 'vitest'
import {
    detachSharedRootFromWrapper,
    keepWrapperForSharedSiblings,
} from './sharedSessionStop'

describe('detachSharedRootFromWrapper', () => {
    it('keeps the wrapper when sibling shared roots remain', () => {
        const session = {
            happySessionId: 'root-a',
            sharedSessions: {
                'root-a': {},
                'root-b': {},
            },
        }
        expect(detachSharedRootFromWrapper(session, 'root-a')).toEqual({ kind: 'keep_wrapper' })
        expect(session.sharedSessions).toEqual({ 'root-b': {} })
    })

    it('keeps the wrapper when primary is a different live root', () => {
        const session = {
            happySessionId: 'root-primary',
            sharedSessions: {
                'root-archived': {},
            },
        }
        expect(detachSharedRootFromWrapper(session, 'root-archived')).toEqual({ kind: 'keep_wrapper' })
        expect(session.sharedSessions).toBeUndefined()
    })

    it('allows kill when the last shared root is the primary being stopped', () => {
        const session = {
            happySessionId: 'root-only',
            sharedSessions: {
                'root-only': {},
            },
        }
        expect(detachSharedRootFromWrapper(session, 'root-only')).toEqual({ kind: 'allow_kill' })
        expect(session.sharedSessions).toBeUndefined()
    })

    it('allows kill when session id is not in sharedSessions', () => {
        const session = {
            happySessionId: 'root-a',
            sharedSessions: { 'root-b': {} },
        }
        expect(detachSharedRootFromWrapper(session, 'root-missing')).toEqual({ kind: 'allow_kill' })
        expect(session.sharedSessions).toEqual({ 'root-b': {} })
    })
})

describe('keepWrapperForSharedSiblings', () => {
    it('returns true and drops the archived root when siblings remain', () => {
        const session = {
            sharedSessions: {
                'root-a': {},
                'root-b': {},
            },
        }
        expect(keepWrapperForSharedSiblings(session, 'root-a')).toBe(true)
        expect(session.sharedSessions).toEqual({ 'root-b': {} })
    })

    it('returns false when no siblings remain', () => {
        const session = {
            sharedSessions: { 'root-a': {} },
        }
        expect(keepWrapperForSharedSiblings(session, 'root-a')).toBe(false)
        expect(session.sharedSessions).toEqual({ 'root-a': {} })
    })
})
